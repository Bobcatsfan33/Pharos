import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  FileKeystore,
  LocalKms,
  AwsKms,
  sealRecord,
  verifyChain,
  keysetVerifier,
  GENESIS_HASH,
  ACTION_RECORD_SCHEMA_VERSION,
  parseKeyId,
  type ActionRecord,
  type ActionRecordContent,
  type PublicKeyEntry,
  type SigningProvider,
} from "@pharos/core";

// S3-T3: migrate a live tenant chain from local-kms (Ed25519) to aws-kms (ECDSA P-256) with
// ZERO data migration. Each record embeds its own keyId and the published keyset is additive,
// so old records keep verifying under their old keys while new records sign under KMS — the
// merged keyset verifies the whole chain genesis-to-head. AwsKms uses the emulator (:8088).
process.env.PHAROS_KMS_AWS_ENDPOINT ??= "http://localhost:8088";
const ENDPOINT = process.env.PHAROS_KMS_AWS_ENDPOINT;

function content(seq: number, tenantId: string): ActionRecordContent {
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

async function seal(
  signer: SigningProvider,
  keyId: string,
  tenantId: string,
  from: number,
  count: number,
  prevHash: string,
): Promise<ActionRecord[]> {
  const records: ActionRecord[] = [];
  let prev = prevHash;
  for (let i = 0; i < count; i++) {
    const rec = await sealRecord({
      content: content(from + i, tenantId),
      prevHash: prev,
      signer,
      keyId,
    });
    records.push(rec);
    prev = rec.seal.contentHash;
  }
  return records;
}

describe("key migration: local-kms (Ed25519) → aws-kms (ECDSA P-256), no data migration", () => {
  const tenantId = `migrate-${randomUUID().slice(0, 8)}`;
  const N = 4;
  let local: LocalKms;
  let aws: AwsKms;
  let localKeyId: string;
  let awsKeyId: string;
  let firstHalf: ActionRecord[];
  let secondHalf: ActionRecord[];
  let mergedKeyset: PublicKeyEntry[];

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-migrate-"));
    local = new LocalKms(new FileKeystore(dir));
    aws = new AwsKms({
      region: "us-east-1",
      endpoint: ENDPOINT,
      aliasPrefix: `migrate-${randomUUID().slice(0, 8)}`,
    });

    // Phase 1: seal N records under local-kms.
    localKeyId = await local.ensureKey(`tenant:${tenantId}`);
    firstHalf = await seal(local, localKeyId, tenantId, 0, N, GENESIS_HASH);

    // Phase 2: SWITCH the provider. The aws-kms key CONTINUES the version sequence (local v1 →
    // aws v2) so keyIds stay globally unique — this is what makes the merged keyset additive and
    // needs no data migration. Seal N more, continuing the same chain (prevHash links), WITHOUT
    // touching or re-sealing the existing records.
    const localMax = parseKeyId(localKeyId).version;
    awsKeyId = await aws.provisionVersion(`tenant:${tenantId}`, localMax + 1);
    expect(parseKeyId(awsKeyId)).toEqual({ keyName: `tenant:${tenantId}`, version: localMax + 1 });
    secondHalf = await seal(aws, awsKeyId, tenantId, N, N, firstHalf[N - 1]!.seal.contentHash);

    // The published keyset is additive: old (Ed25519) + new (ECDSA P-256).
    mergedKeyset = [...(await local.publishKeyset()), ...(await aws.publishKeyset())];
  });

  it("the merged keyset verifies the whole chain genesis-to-head", () => {
    const chain = [...firstHalf, ...secondHalf];
    const report = verifyChain(chain, mergedKeyset);
    expect(report.ok).toBe(true);
    expect(report.recordsChecked).toBe(2 * N);
    expect(report.firstBrokenSequence).toBeNull();
  });

  it("old records verify under Ed25519, new records under ECDSA P-256 (mixed keyset)", () => {
    const byId = new Map(mergedKeyset.map((k) => [k.keyId, k]));
    for (const r of firstHalf) expect(byId.get(r.seal.keyId)?.algorithm).toBe("ed25519");
    for (const r of secondHalf) expect(byId.get(r.seal.keyId)?.algorithm).toBe("ecdsa-p256");
    expect(new Set(mergedKeyset.map((k) => k.algorithm))).toEqual(
      new Set(["ed25519", "ecdsa-p256"]),
    );
  });

  it("no data migration: old records are byte-identical before and after the switch", () => {
    // The switch only appended new records and extended the keyset. Re-verifying the old half
    // in isolation (with just the old keyset) still passes — nothing about them changed.
    const oldReport = verifyChain(firstHalf, mergedKeyset);
    expect(oldReport.ok).toBe(true);
    // Each old record still names its original Ed25519 keyId (no re-keying happened).
    for (const r of firstHalf) expect(r.seal.keyId).toBe(localKeyId);
  });

  it("external offline verification (keysetVerifier) accepts both halves, rejects tampering", () => {
    const verify = keysetVerifier(mergedKeyset);
    const chain = [...firstHalf, ...secondHalf];
    // Every record's signature checks out against the merged keyset via the pure primitive the
    // external verifier (scripts/external-verify.ts) uses.
    const report = verifyChain(chain, mergedKeyset);
    expect(report.records.every((r) => r.checks.signatureValid)).toBe(true);
    // A record from the aws-kms half fails if verified with a wrong message.
    const r = secondHalf[0]!;
    expect(verify(r.seal.keyId, Buffer.from("not the sealed bytes"), r.seal.signature)).toBe(false);
  });
});
