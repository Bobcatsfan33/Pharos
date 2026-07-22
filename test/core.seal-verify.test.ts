import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  FileKeystore,
  LocalKms,
  sealRecord,
  verifyChain,
  verifyRecord,
  GENESIS_HASH,
  ACTION_RECORD_SCHEMA_VERSION,
  type ActionRecord,
  type ActionRecordContent,
} from "@pharos/core";

function content(seq: number, tenantId = "t1"): ActionRecordContent {
  return {
    schemaVersion: ACTION_RECORD_SCHEMA_VERSION,
    id: randomUUID(),
    tenantId,
    sequence: seq,
    action: {
      type: "email.send",
      agentId: "a1",
      payload: { n: seq },
      emittedAt: "2026-01-01T00:00:00.000Z",
    },
    verdict: {
      decision: "allow",
      tierReached: 1,
      ruleCitations: [],
      riskScore: 0,
      failMode: null,
      judgeVersion: null,
      latency: { totalMs: 1, perTier: { "1": 1 }, deadlineMs: 800, deadlineBreached: false },
    },
    liability: {
      mandate: null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
    },
    sealedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("seal + chain verification", () => {
  let kms: LocalKms;
  let keyId: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-seal-"));
    kms = new LocalKms(new FileKeystore(dir));
    keyId = await kms.ensureKey("env:test");
  });

  async function buildChain(n: number): Promise<ActionRecord[]> {
    const records: ActionRecord[] = [];
    let prev = GENESIS_HASH;
    for (let i = 0; i < n; i++) {
      const rec = await sealRecord({ content: content(i), prevHash: prev, signer: kms, keyId });
      records.push(rec);
      prev = rec.seal.contentHash;
    }
    return records;
  }

  it("verifies a clean chain from genesis to head", async () => {
    const chain = await buildChain(5);
    const keyset = await kms.publishKeyset();
    const report = verifyChain(chain, keyset);
    expect(report.ok).toBe(true);
    expect(report.recordsChecked).toBe(5);
    expect(report.firstBrokenSequence).toBeNull();
  });

  it("detects content tampering (hash mismatch)", async () => {
    const chain = await buildChain(3);
    const keyset = await kms.publishKeyset();
    // Tamper with the payload of record 1 without re-sealing.
    (chain[1]!.content.action.payload as Record<string, unknown>).n = 999;
    const report = verifyChain(chain, keyset);
    expect(report.ok).toBe(false);
    expect(report.firstBrokenSequence).toBe(1);
    expect(report.records[1]!.checks.contentHashMatches).toBe(false);
  });

  it("detects a broken chain link", async () => {
    const chain = await buildChain(3);
    const keyset = await kms.publishKeyset();
    chain[2]!.seal.prevHash = "f".repeat(64);
    const report = verifyChain(chain, keyset);
    expect(report.ok).toBe(false);
    expect(report.firstBrokenSequence).toBe(2);
    expect(report.records[2]!.checks.chainLinkValid).toBe(false);
  });

  it("detects a forged signature", async () => {
    const chain = await buildChain(2);
    const keyset = await kms.publishKeyset();
    chain[1]!.seal.signature = Buffer.from("not a real signature").toString("base64");
    const rv = verifyRecord(
      chain[1]!,
      chain[0]!.seal.contentHash,
      new Map(keyset.map((k) => [k.keyId, k])),
    );
    expect(rv.checks.signatureValid).toBe(false);
  });

  it("fails verification when the keyset is missing the signing key", async () => {
    const chain = await buildChain(1);
    const report = verifyChain(chain, []);
    expect(report.ok).toBe(false);
  });
});
