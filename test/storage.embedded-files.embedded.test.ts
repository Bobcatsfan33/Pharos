import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalKms, verifyChain } from "@pharos/core";
import {
  EMBEDDED_EVIDENCE_POSTURE,
  WormIntegrityError,
  buildEmbeddedStorage,
  type EmbeddedStorageBackend,
} from "@pharos/storage";
import { MemoryKeystore } from "./support/memoryKeystore.js";

/**
 * What the embedded evidence tier guarantees, and — just as important — what it does not.
 * These tests pin the honest label: tamper-EVIDENT, not tamper-PROOF.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function make(): Promise<{
  backend: EmbeddedStorageBackend;
  signer: LocalKms;
  dataDir: string;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "pharos-embedded-files-"));
  dirs.push(dataDir);
  const signer = new LocalKms(new MemoryKeystore());
  const backend = await buildEmbeddedStorage(
    { dataDir },
    { signer, resolveKeyName: (t) => `tenant:${t}` },
  );
  return { backend, signer, dataDir };
}

const input = (tenantId: string, n: number) => ({
  tenantId,
  action: {
    type: "shell.exec",
    agentId: "a",
    payload: { cmd: `echo ${n}` },
    emittedAt: new Date().toISOString(),
  },
  verdict: {
    decision: "allow" as const,
    tierReached: 1 as const,
    ruleCitations: [],
    riskScore: 0,
    failMode: null,
    judgeVersion: null,
    latency: { totalMs: 1, perTier: {}, deadlineMs: 800, deadlineBreached: false },
  },
  liability: {
    mandate: null,
    oversightMode: "autonomous" as const,
    blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" as const },
    modelMetadata: null,
  },
});

describe("embedded evidence files", () => {
  it("the posture never claims WORM or RLS", () => {
    expect(EMBEDDED_EVIDENCE_POSTURE.worm).toBe(false);
    expect(EMBEDDED_EVIDENCE_POSTURE.rowLevelSecurity).toBe(false);
    expect(EMBEDDED_EVIDENCE_POSTURE.multiInstanceRateLimits).toBe(false);
    expect(EMBEDDED_EVIDENCE_POSTURE.description).toMatch(/NOT write-once/);
  });

  it("every sealed record has a read-only, content-addressed file that verifies on read", async () => {
    const { backend } = await make();
    const r = await backend.store.append(input("t1", 0));
    const key = backend.files.keyFor("t1", 0, r.seal.contentHash);
    const path = backend.files.pathFor(key);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(r);
    expect(backend.files.getRecord(key)).toEqual(r);
    expect(backend.files.getRecord("t1/000000000099-" + "0".repeat(64) + ".json")).toBeNull();
    await backend.close();
  });

  it("the file store never overwrites: a different record at an existing address is refused", async () => {
    const { backend } = await make();
    const r = await backend.store.append(input("t2", 0));
    expect(backend.files.putRecord(r)).toEqual({
      key: backend.files.keyFor("t2", 0, r.seal.contentHash),
    });
    const forged = {
      ...r,
      content: { ...r.content, action: { ...r.content.action, payload: { cmd: "rm -rf /" } } },
    };
    expect(() => backend.files.putRecord(forged)).toThrow(WormIntegrityError);
    await backend.close();
  });

  it("tampering with a record file is DETECTED, not prevented: verify-on-read throws and the chain still verifies from the operational copy", async () => {
    const { backend, signer } = await make();
    const r = await backend.store.append(input("t3", 0));
    const key = backend.files.keyFor("t3", 0, r.seal.contentHash);
    const path = backend.files.pathFor(key);
    chmodSync(path, 0o644);
    writeFileSync(
      path,
      JSON.stringify({
        ...r,
        content: { ...r.content, action: { ...r.content.action, payload: { cmd: "echo 9999" } } },
      }),
    );
    expect(() => backend.files.getRecord(key)).toThrow(/content hash mismatch/);
    const report = verifyChain(await backend.store.getChain("t3"), await signer.publishKeyset());
    expect(report.ok).toBe(true);
    await backend.close();
  });

  it("a deleted record file is reported as missing evidence (never ok); an orphan is benign", async () => {
    const { backend } = await make();
    const a = await backend.store.append(input("t4", 0));
    await backend.store.append(input("t4", 1));
    unlinkSync(backend.files.pathFor(backend.files.keyFor("t4", 0, a.seal.contentHash)));
    const r1 = await backend.store.reconcileEvidence("t4");
    expect(r1.ok).toBe(false);
    expect(r1.missing.map((m) => m.sequence)).toEqual([0]);
    // An orphan (file with no committed row) is surfaced but does not fail reconciliation.
    writeFileSync(backend.files.pathFor("t4/000000000007-" + "f".repeat(64) + ".json"), "{}");
    const r2 = await backend.store.reconcileEvidence("t4");
    expect(r2.orphans).toHaveLength(1);
    expect(r2.ok).toBe(false); // still false: the missing file above is still missing
    await backend.close();
  });

  it("a failed file write aborts the append: no row, no head advance, chain intact", async () => {
    const { backend, signer } = await make();
    await backend.store.append(input("t5", 0));
    const original = backend.files.putRecord.bind(backend.files);
    backend.files.putRecord = () => {
      throw new Error("disk full");
    };
    await expect(backend.store.append(input("t5", 1))).rejects.toThrow("disk full");
    backend.files.putRecord = original;
    expect(await backend.store.count("t5")).toBe(1);
    expect((await backend.store.getHead("t5"))?.sequence).toBe(0);
    const next = await backend.store.append(input("t5", 2));
    expect(next.content.sequence).toBe(1);
    expect(verifyChain(await backend.store.getChain("t5"), await signer.publishKeyset()).ok).toBe(
      true,
    );
    await backend.close();
  });

  it("state survives reopening the same data directory", async () => {
    const { backend, signer, dataDir } = await make();
    await backend.store.append(input("t6", 0));
    await backend.store.append(input("t6", 1));
    await backend.close();
    const reopened = await buildEmbeddedStorage(
      { dataDir },
      { signer, resolveKeyName: (t) => `tenant:${t}` },
    );
    expect(await reopened.store.count("t6")).toBe(2);
    expect(verifyChain(await reopened.store.getChain("t6"), await signer.publishKeyset()).ok).toBe(
      true,
    );
    const third = await reopened.store.append(input("t6", 2));
    expect(third.content.sequence).toBe(2);
    await reopened.close();
  });
});
