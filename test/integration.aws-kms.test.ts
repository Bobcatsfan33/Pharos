import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  AwsKms,
  sealRecord,
  verifyChain,
  GENESIS_HASH,
  ACTION_RECORD_SCHEMA_VERSION,
  type ActionRecord,
  type ActionRecordContent,
} from "@pharos/core";
import { runSigningConformance } from "./signingConformance.js";

// AwsKms integration against a KMS emulator (nsmithuk/local-kms; see S3-T0 spike). CI provides
// the emulator on this endpoint; locally: `docker run -d -p 8088:8080 nsmithuk/local-kms`.
// Self-provided default mirrors the other integration tests (Postgres/Redis/MinIO).
process.env.PHAROS_KMS_AWS_ENDPOINT ??= "http://localhost:8088";
const ENDPOINT = process.env.PHAROS_KMS_AWS_ENDPOINT;

// One provider instance for the run, under a run-unique alias namespace so publishKeyset()
// doesn't collide with other test runs against the same (stateful) emulator.
const kms = new AwsKms({
  region: "us-east-1",
  endpoint: ENDPOINT,
  aliasPrefix: `conf-${randomUUID().slice(0, 8)}`,
});

runSigningConformance({
  name: "AwsKms (ECDSA P-256, emulator)",
  expectedAlgorithm: "ecdsa-p256",
  makeProvider: () => kms,
});

function content(seq: number, tenantId = "aws-kms-tenant"): ActionRecordContent {
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

describe("AwsKms end-to-end seal + offline chain verification (ECDSA P-256)", () => {
  let signer: AwsKms;
  let keyId: string;

  beforeAll(async () => {
    signer = new AwsKms({
      region: "us-east-1",
      endpoint: ENDPOINT,
      aliasPrefix: `e2e-${randomUUID().slice(0, 8)}`,
    });
    keyId = await signer.ensureKey("aws-kms-tenant:signing");
  });

  async function buildChain(n: number): Promise<ActionRecord[]> {
    const records: ActionRecord[] = [];
    let prev = GENESIS_HASH;
    for (let i = 0; i < n; i++) {
      const rec = await sealRecord({ content: content(i), prevHash: prev, signer, keyId });
      records.push(rec);
      prev = rec.seal.contentHash;
    }
    return records;
  }

  it("seals a chain under aws-kms and verifies it offline genesis-to-head", async () => {
    const chain = await buildChain(4);
    const keyset = await signer.publishKeyset();
    // The published keyset carries ecdsa-p256 keys; offline verification dispatches on it.
    expect(keyset.every((k) => k.algorithm === "ecdsa-p256")).toBe(true);

    const report = verifyChain(chain, keyset);
    expect(report.ok).toBe(true);
    expect(report.recordsChecked).toBe(4);
    expect(report.firstBrokenSequence).toBeNull();
  });

  it("offline verification detects tampering on an aws-kms-sealed chain", async () => {
    const chain = await buildChain(3);
    const keyset = await signer.publishKeyset();
    (chain[1]!.content.action.payload as Record<string, unknown>).n = 999;
    const report = verifyChain(chain, keyset);
    expect(report.ok).toBe(false);
    expect(report.firstBrokenSequence).toBe(1);
  });
});
