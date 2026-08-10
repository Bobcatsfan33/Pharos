import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AwsKms,
  LocalKms,
  FileKeystore,
  sealRecord,
  verifyRecord,
  verifyChain,
  GENESIS_HASH,
  ACTION_RECORD_SCHEMA_VERSION,
  sealAlgorithmIsAuthoritative,
  type ActionRecord,
  type ActionRecordContent,
  type PublicKeyEntry,
  type SigningProvider,
} from "@pharos/core";

/**
 * `seal.algorithm` states the real signing algorithm from schema v1.1 (ADR 0005, #67).
 *
 * The defect: `sealRecord` hardcoded `algorithm: "ed25519"`, so every aws-kms record
 * (ECDSA P-256) claimed Ed25519 while its keyset entry said otherwise. Not a
 * verification vulnerability — verification dispatches on the keyset entry, and the
 * field is not covered by the signature — but litigation-grade evidence that misstates
 * its own signature algorithm is an inconsistency we cannot explain to an examiner.
 *
 * The three properties that matter here:
 *   1. new records tell the truth, on BOTH providers;
 *   2. legacy v1.0.0 records still verify green even though they misstate it — they are
 *      never rewritten (D2), so the consistency check must not fail honest history;
 *   3. the check is CONSISTENCY, never dispatch — a mismatch invalidates the record
 *      rather than choosing which algorithm to verify with.
 */
process.env.PHAROS_KMS_AWS_ENDPOINT ??= "http://localhost:8088";
const ENDPOINT = process.env.PHAROS_KMS_AWS_ENDPOINT;

let awsKms: AwsKms | null = null;
let localKms: LocalKms | null = null;
let awsAvailable = true;

beforeAll(async () => {
  localKms = new LocalKms(
    new FileKeystore(mkdtempSync(join(tmpdir(), "pharos-alg-")), "pharos-test-keystore-passphrase"),
  );
  try {
    awsKms = new AwsKms({
      region: "us-east-1",
      endpoint: ENDPOINT,
      aliasPrefix: `alg-${randomUUID().slice(0, 8)}`,
      allowKeyCreation: true,
    });
    await awsKms.ensureKey("probe");
  } catch (err) {
    console.warn("[seal-algorithm] KMS emulator unavailable, skipping:", (err as Error).message);
    awsAvailable = false;
  }
});

function content(sequence: number): ActionRecordContent {
  return {
    schemaVersion: ACTION_RECORD_SCHEMA_VERSION,
    id: randomUUID(),
    tenantId: "alg-tenant",
    sequence,
    action: {
      type: "email.send",
      agentId: "a1",
      payload: { to: "x@y.com" },
      emittedAt: new Date(0).toISOString(),
    },
    verdict: {
      decision: "allow",
      tierReached: 1,
      ruleCitations: [],
      riskScore: 0,
      failMode: null,
      judgeVersion: null,
      latency: { totalMs: 1, perTier: {}, deadlineMs: 800, deadlineBreached: false },
    },
    liability: {
      mandate: null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
    },
    sealedAt: new Date(0).toISOString(),
  } as unknown as ActionRecordContent;
}

async function seal(signer: SigningProvider, keyName: string, sequence = 0, prev = GENESIS_HASH) {
  const keyId = await signer.ensureKey(keyName);
  const record = await sealRecord({ content: content(sequence), prevHash: prev, signer, keyId });
  const keyset = await signer.publishKeyset();
  return { record, keyset };
}

describe("new records state their real algorithm", () => {
  it("seals ed25519 under LocalKms and verifies", async () => {
    const { record, keyset } = await seal(localKms!, "k-ed");
    expect(record.content.schemaVersion).toBe("1.1.0");
    expect(record.seal.algorithm).toBe("ed25519");
    expect(verifyChain([record], keyset).ok).toBe(true);
  });

  it("seals ecdsa-p256 under AwsKms — the record #67 was mislabelling", async (ctx) => {
    if (!awsAvailable) return ctx.skip();
    const { record, keyset } = await seal(awsKms!, "k-ec");

    // Before the fix this said "ed25519" while the keyset said "ecdsa-p256".
    expect(record.seal.algorithm).toBe("ecdsa-p256");
    const entry = keyset.find((k) => k.keyId === record.seal.keyId)!;
    expect(record.seal.algorithm).toBe(entry.algorithm);
    expect(verifyChain([record], keyset).ok).toBe(true);
  });

  it("refuses to seal when the signing key has no published entry", async () => {
    // Guessing an algorithm is what created this defect; refusing is the safe failure.
    // Delegate rather than spread: spreading a class instance drops its prototype methods.
    const base = localKms!;
    const blind: SigningProvider = {
      providerId: base.providerId,
      ensureKey: (n) => base.ensureKey(n),
      rotate: (n) => base.rotate(n),
      activeKeyId: (n) => base.activeKeyId(n),
      sign: (k, m) => base.sign(k, m),
      publishKeyset: () => base.publishKeyset(),
      getPublicKey: async () => null,
    };
    const keyId = await localKms!.ensureKey("k-blind");
    await expect(
      sealRecord({ content: content(0), prevHash: GENESIS_HASH, signer: blind, keyId }),
    ).rejects.toThrow(/cannot be stated truthfully/);
  });
});

describe("the check is consistency, not dispatch", () => {
  it("invalidates a v1.1 record whose seal.algorithm disagrees with its key", async () => {
    const { record, keyset } = await seal(localKms!, "k-mismatch");
    // Same bytes, same valid signature — only the self-description is wrong.
    const lying: ActionRecord = { ...record, seal: { ...record.seal, algorithm: "ecdsa-p256" } };

    const result = verifyRecord(lying, GENESIS_HASH, new Map(keyset.map((k) => [k.keyId, k])));

    expect(result.ok).toBe(false);
    expect(result.checks.sealAlgorithmMatches).toBe(false);
    // The signature itself is still fine: the field was never used to verify it.
    expect(result.checks.signatureValid).toBe(true);
    expect(result.errors.join(" ")).toMatch(/seal algorithm mismatch/);
  });
});

describe("legacy v1.0.0 records are never failed by the new check", () => {
  it("verifies a v1.0.0 record that misstates ed25519 over an ecdsa key", async (ctx) => {
    if (!awsAvailable) return ctx.skip();
    const { record, keyset } = await seal(awsKms!, "k-legacy");

    // Reconstruct the pre-fix shape: schemaVersion 1.0.0 AND the old hardcoded label.
    // The signature covers {contentHash, prevHash, sequence} and contentHash covers
    // `content`, so we must re-seal to keep the hash honest for the 1.0.0 content.
    const legacyContent = { ...record.content, schemaVersion: "1.0.0" } as ActionRecordContent;
    const keyId = record.seal.keyId;
    const resealed = await sealRecord({
      content: legacyContent,
      prevHash: GENESIS_HASH,
      signer: awsKms!,
      keyId,
    });
    const legacy: ActionRecord = {
      ...resealed,
      seal: { ...resealed.seal, algorithm: "ed25519" }, // the historical misstatement
    };

    expect(sealAlgorithmIsAuthoritative("1.0.0")).toBe(false);
    const result = verifyRecord(legacy, GENESIS_HASH, new Map(keyset.map((k) => [k.keyId, k])));

    // Honest historical evidence must still verify. Failing it would be the new check
    // punishing records for a defect they could not have avoided.
    expect(result.checks.sealAlgorithmMatches).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("verifies a mixed chain spanning the v1.0.0 -> v1.1.0 boundary", async () => {
    // The deploy-day case: records sealed before the bump, then records after it.
    const keyId = await localKms!.ensureKey("k-mixed");

    const v10 = await sealRecord({
      content: { ...content(0), schemaVersion: "1.0.0" } as ActionRecordContent,
      prevHash: GENESIS_HASH,
      signer: localKms!,
      keyId,
    });
    const v11 = await sealRecord({
      content: content(1),
      prevHash: v10.seal.contentHash,
      signer: localKms!,
      keyId,
    });

    expect(v10.content.schemaVersion).toBe("1.0.0");
    expect(v11.content.schemaVersion).toBe("1.1.0");

    const keyset: PublicKeyEntry[] = await localKms!.publishKeyset();
    const chain = verifyChain([v10, v11], keyset);
    expect(chain.ok).toBe(true);
  });
});
