import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  FileKeystore,
  LocalKms,
  sealRecord,
  verifyRecord,
  signingMessage,
  GENESIS_HASH,
  SEAL_SIGNATURE_VERSION,
  ACTION_RECORD_SCHEMA_VERSION,
  type ActionRecord,
  type ActionRecordContent,
  type PublicKeyEntry,
  sha256Hex,
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

describe("seal signature v2 (anti-splice)", () => {
  let kms: LocalKms;
  let keyId: string;
  let keyset: Map<string, PublicKeyEntry>;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-seal-v2-"));
    kms = new LocalKms(new FileKeystore(dir));
    keyId = await kms.ensureKey("tenant-t1");
    const keys = await kms.publishKeyset();
    keyset = new Map(keys.map((k) => [k.keyId, k]));
  });

  it("new seals carry sigVersion 2 and verify end-to-end", async () => {
    const record = await sealRecord({
      content: content(0),
      prevHash: GENESIS_HASH,
      signer: kms,
      keyId,
    });
    expect(record.seal.sigVersion).toBe(SEAL_SIGNATURE_VERSION);
    const v = verifyRecord(record, GENESIS_HASH, keyset);
    expect(v.checks.signatureValid).toBe(true);
    expect(v.ok).toBe(true);
  });

  it("a spliced record fails signature verification even when the chain link matches", async () => {
    // Attacker takes a legitimately signed record and rewrites its prevHash to
    // splice it after a different record. Under v1 the signature (contentHash
    // only) still verified and only the unsigned chain-link check could
    // object — and the attacker controls the expected prevHash by choosing
    // the splice point. Under v2 the signature itself pins prevHash.
    const record = await sealRecord({
      content: content(1),
      prevHash: GENESIS_HASH,
      signer: kms,
      keyId,
    });
    const foreignPrev = sha256Hex({ some: "other record" });
    const spliced: ActionRecord = {
      content: record.content,
      seal: { ...record.seal, prevHash: foreignPrev },
    };
    const v = verifyRecord(spliced, foreignPrev, keyset);
    expect(v.checks.chainLinkValid).toBe(true); // the splice point "matches"
    expect(v.checks.signatureValid).toBe(false); // but the signature pins the real prevHash
    expect(v.ok).toBe(false);
  });

  it("legacy v1 seals still verify; relabeling a v1 seal as v2 fails", async () => {
    // Hand-build a legacy record exactly as the pre-v2 sealer did: signature
    // over contentHash bytes, no sigVersion field.
    const c = content(2);
    const contentHash = sha256Hex(c);
    const signature = await kms.sign(keyId, signingMessage(contentHash));
    const legacy: ActionRecord = {
      content: c,
      seal: { contentHash, prevHash: GENESIS_HASH, algorithm: "ed25519", keyId, signature },
    };
    const v1 = verifyRecord(legacy, GENESIS_HASH, keyset);
    expect(v1.checks.signatureValid).toBe(true);
    expect(v1.ok).toBe(true);

    const relabeled: ActionRecord = { content: c, seal: { ...legacy.seal, sigVersion: 2 } };
    const v2 = verifyRecord(relabeled, GENESIS_HASH, keyset);
    expect(v2.checks.signatureValid).toBe(false);
    expect(v2.ok).toBe(false);
  });
});
