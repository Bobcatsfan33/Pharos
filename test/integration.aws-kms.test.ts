import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  AwsKms,
  awsKmsAliasName,
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
  // The emulator starts empty; this suite exercises the creating paths deliberately.
  allowKeyCreation: true,
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
      allowKeyCreation: true,
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

// Implicit key creation is the operator-facing contract change: an unprovisioned key must fail
// closed, and the refusal must be self-documenting (the alias to provision AND the opt-in flag),
// because that message is the only place an operator learns the alias derivation at the moment
// they need it.
describe("AwsKms key provisioning is explicit", () => {
  const strictPrefix = `strict-${randomUUID().slice(0, 8)}`;
  const strict = new AwsKms({
    region: "us-east-1",
    endpoint: ENDPOINT,
    aliasPrefix: strictPrefix,
    // allowKeyCreation omitted — the default must be fail-closed.
  });

  it("refuses to mint a key on first use, naming the alias and the opt-in flag", async () => {
    const keyName = "tenant:unprovisioned";
    const expectedAlias = awsKmsAliasName(strictPrefix, keyName, 1);

    await expect(strict.ensureKey(keyName)).rejects.toThrow(/implicit key creation is disabled/i);
    // The message must carry the exact alias to provision and the flag that would permit
    // creation — it is the operator's documentation at the point of failure.
    await expect(strict.ensureKey(keyName)).rejects.toThrow(expectedAlias);
    await expect(strict.ensureKey(keyName)).rejects.toThrow(
      /PHAROS_KMS_AWS_ALLOW_KEY_CREATION=true/,
    );
    // And it really did not create anything.
    expect(await strict.publishKeyset()).toEqual([]);
  });

  it("uses a pre-provisioned key at the derived alias without creating one", async () => {
    const prefix = `preprov-${randomUUID().slice(0, 8)}`;
    const keyName = "tenant:preprovisioned";
    // Stand in for the operator: create the CMK and alias it at the documented identifier.
    const creator = new AwsKms({
      region: "us-east-1",
      endpoint: ENDPOINT,
      aliasPrefix: prefix,
      allowKeyCreation: true,
    });
    const provisioned = await creator.ensureKey(keyName);

    // A strict provider over the same namespace binds to it rather than refusing.
    const bound = new AwsKms({ region: "us-east-1", endpoint: ENDPOINT, aliasPrefix: prefix });
    expect(await bound.ensureKey(keyName)).toBe(provisioned);
    const sig = await bound.sign(provisioned, Buffer.from("bound-to-operator-key"));
    expect(sig.length).toBeGreaterThan(0);
  });

  it("throws on a version collision instead of minting a duplicate keyId", async () => {
    const prefix = `collide-${randomUUID().slice(0, 8)}`;
    const kms2 = new AwsKms({
      region: "us-east-1",
      endpoint: ENDPOINT,
      aliasPrefix: prefix,
      allowKeyCreation: true,
    });
    await kms2.ensureKey("tenant:collide");
    await expect(kms2.provisionVersion("tenant:collide", 1)).rejects.toThrow(/already exists/i);
  });
});

describe("AwsKms version discovery cache", () => {
  it("reuses discovery on the seal path and invalidates around explicit mutations", async () => {
    const cached = new AwsKms({
      region: "us-east-1",
      endpoint: ENDPOINT,
      aliasPrefix: `cache-${randomUUID().slice(0, 8)}`,
      allowKeyCreation: true,
    });
    await cached.ensureKey("tenant:cache");

    const client = (
      cached as unknown as {
        client: { send(command: unknown): Promise<unknown> };
      }
    ).client;
    const send = vi.spyOn(client, "send");
    const listCalls = () =>
      send.mock.calls.filter(([command]) => command?.constructor.name === "ListAliasesCommand")
        .length;

    expect(await cached.activeKeyId("tenant:cache")).toBe("tenant:cache#v1");
    const afterFirstRead = listCalls();
    expect(afterFirstRead).toBeGreaterThan(0);
    expect(await cached.activeKeyId("tenant:cache")).toBe("tenant:cache#v1");
    expect(listCalls()).toBe(afterFirstRead);

    expect(await cached.rotate("tenant:cache")).toBe("tenant:cache#v2");
    const afterRotate = listCalls();
    expect(afterRotate).toBeGreaterThan(afterFirstRead);
    expect(await cached.activeKeyId("tenant:cache")).toBe("tenant:cache#v2");
    const afterRotationRefresh = listCalls();
    expect(afterRotationRefresh).toBeGreaterThan(afterRotate);
    expect(await cached.activeKeyId("tenant:cache")).toBe("tenant:cache#v2");
    expect(listCalls()).toBe(afterRotationRefresh);

    expect(await cached.provisionVersion("tenant:cache", 3)).toBe("tenant:cache#v3");
    const afterProvision = listCalls();
    expect(afterProvision).toBeGreaterThan(afterRotationRefresh);
    expect(await cached.activeKeyId("tenant:cache")).toBe("tenant:cache#v3");
    const afterProvisionRefresh = listCalls();
    expect(afterProvisionRefresh).toBeGreaterThan(afterProvision);
    expect(await cached.activeKeyId("tenant:cache")).toBe("tenant:cache#v3");
    expect(listCalls()).toBe(afterProvisionRefresh);
  });
});
