import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  FileKeystore,
  LocalKms,
  sealRecord,
  computeDisclosures,
  disclosureBindingMessage,
  redactPayload,
  verifyRedactedView,
  keysetVerifier,
  GENESIS_HASH,
  ACTION_RECORD_SCHEMA_VERSION,
  type ActionRecordContent,
} from "@pharos/core";
import { assembleClaimsPack, verifyClaimsPack, createTimestamp, verifyTimestamp, type RecordDisclosureInput } from "@pharos/evidence";

let kms: LocalKms;
let tsa: LocalKms;
let keyId: string;

function content(seq: number, payload: Record<string, unknown>): ActionRecordContent {
  return {
    schemaVersion: ACTION_RECORD_SCHEMA_VERSION,
    id: randomUUID(),
    tenantId: "t1",
    sequence: seq,
    action: { type: "payment.transfer", agentId: "a1", payload, emittedAt: "2026-05-01T00:00:00.000Z" },
    verdict: { decision: "allow", tierReached: 1, ruleCitations: [], riskScore: 0, failMode: null, judgeVersion: null, latency: { totalMs: 1, perTier: {}, deadlineMs: 800, deadlineBreached: false } },
    liability: { mandate: null, oversightMode: "autonomous", blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" }, modelMetadata: null },
    sealedAt: "2026-05-01T00:00:00.000Z",
  };
}

async function sealWithDisclosure(seq: number, payload: Record<string, unknown>, prevHash: string): Promise<RecordDisclosureInput> {
  const record = await sealRecord({ content: content(seq, payload), prevHash, signer: kms, keyId });
  const disclosures = computeDisclosures(payload);
  const sig = await kms.sign(keyId, disclosureBindingMessage(disclosures.disclosureRoot, record.seal.contentHash));
  return { record, disclosureRoot: disclosures.disclosureRoot, disclosureSignature: sig, salts: disclosures.salts, commitments: disclosures.commitments, keyId };
}

describe("evidence — selective-disclosure redaction", () => {
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-ev-"));
    kms = new LocalKms(new FileKeystore(dir));
    tsa = new LocalKms(new FileKeystore(`${dir}-tsa`));
    keyId = await kms.ensureKey("t1");
  });

  it("redacts a field while the view still verifies; the redacted value is hidden", async () => {
    const payload = { amount: 30000, to: "vendor-x", memo: "Q2 settlement" };
    const r = await sealWithDisclosure(0, payload, GENESIS_HASH);
    const view = redactPayload({
      recordId: r.record.content.id,
      contentHash: r.record.seal.contentHash,
      payload,
      commitments: r.commitments,
      salts: r.salts,
      disclosureRoot: r.disclosureRoot,
      disclosureSignature: r.disclosureSignature,
      keyId,
      redactFields: ["to"],
    });
    const keyset = await kms.publishKeyset();
    const verification = verifyRedactedView(view, keysetVerifier(keyset));
    expect(verification.ok).toBe(true);
    expect(verification.redactedFields).toContain("to");
    expect(view.fields.to!.value).toBeUndefined(); // hidden
    expect(view.fields.amount!.value).toBe(30000); // shown
  });

  it("detects tampering with a shown field", async () => {
    const payload = { amount: 30000, to: "vendor-x" };
    const r = await sealWithDisclosure(0, payload, GENESIS_HASH);
    const view = redactPayload({ recordId: r.record.content.id, contentHash: r.record.seal.contentHash, payload, commitments: r.commitments, salts: r.salts, disclosureRoot: r.disclosureRoot, disclosureSignature: r.disclosureSignature, keyId, redactFields: [] });
    view.fields.amount!.value = 1; // attacker lowers the amount
    const verification = verifyRedactedView(view, keysetVerifier(await kms.publishKeyset()));
    expect(verification.ok).toBe(false);
  });
});

describe("evidence — trusted timestamps", () => {
  it("creates and verifies a timestamp, and detects tampering", async () => {
    const ts = await createTimestamp(tsa, "tsa-test", "a".repeat(64), "2026-05-01T00:00:00.000Z");
    const verify = keysetVerifier(await tsa.publishKeyset());
    expect(verifyTimestamp(ts, verify)).toBe(true);
    expect(verifyTimestamp({ ...ts, hash: "b".repeat(64) }, verify)).toBe(false);
  });
});

describe("evidence — claims packs verify offline", () => {
  async function buildChain(n: number): Promise<RecordDisclosureInput[]> {
    const recs: RecordDisclosureInput[] = [];
    let prev = GENESIS_HASH;
    for (let i = 0; i < n; i++) {
      const r = await sealWithDisclosure(i, { amount: 1000 * (i + 1), to: `vendor-${i}` }, prev);
      recs.push(r);
      prev = r.record.seal.contentHash;
    }
    return recs;
  }

  it("verifies a full (unredacted) pack offline", async () => {
    const recs = await buildChain(3);
    const head = recs[recs.length - 1]!.record.seal.contentHash;
    const ts = await createTimestamp(tsa, "tsa-test", head, "2026-05-01T00:00:00.000Z");
    const bundle = assembleClaimsPack({
      id: randomUUID(), tenantId: "t1", incident: "INC-1", audience: "outside_counsel",
      fromSequence: 0, toSequence: 2, redactFields: [], records: recs,
      keyset: await kms.publishKeyset(), tsaKeyset: await tsa.publishKeyset(), anchors: [ts],
      sealedBy: "counsel", sealedAt: "2026-05-01T00:00:00.000Z",
    });
    const v = verifyClaimsPack(bundle);
    expect(v.ok).toBe(true);
    expect(v.recordsChecked).toBe(3);
    expect(v.anchorsVerified).toBe(1);
  });

  it("verifies a redacted pack offline (originals not present)", async () => {
    const recs = await buildChain(3);
    const head = recs[recs.length - 1]!.record.seal.contentHash;
    const ts = await createTimestamp(tsa, "tsa-test", head, "2026-05-01T00:00:00.000Z");
    const bundle = assembleClaimsPack({
      id: randomUUID(), tenantId: "t1", incident: "INC-2", audience: "claims_adjuster",
      fromSequence: 0, toSequence: 2, redactFields: ["to"], records: recs,
      keyset: await kms.publishKeyset(), tsaKeyset: await tsa.publishKeyset(), anchors: [ts],
      sealedBy: "adjuster", sealedAt: "2026-05-01T00:00:00.000Z",
    });
    const v = verifyClaimsPack(bundle);
    expect(v.ok).toBe(true);
    expect(v.redactedRecords).toBe(3);
    // The redacted field is absent from the bundle entirely.
    const json = JSON.stringify(bundle);
    expect(json).not.toContain("vendor-1");
  });

  it("detects a tampered bundle", async () => {
    const recs = await buildChain(2);
    const ts = await createTimestamp(tsa, "tsa-test", recs[1]!.record.seal.contentHash, "2026-05-01T00:00:00.000Z");
    const bundle = assembleClaimsPack({
      id: randomUUID(), tenantId: "t1", incident: "INC-3", audience: "regulator",
      fromSequence: 0, toSequence: 1, redactFields: [], records: recs,
      keyset: await kms.publishKeyset(), tsaKeyset: await tsa.publishKeyset(), anchors: [ts],
      sealedBy: "x", sealedAt: "2026-05-01T00:00:00.000Z",
    });
    // Tamper a full record's content after sealing the bundle.
    (bundle.records[0] as { record: { content: { action: { payload: Record<string, unknown> } } } }).record.content.action.payload.amount = 999999;
    const v = verifyClaimsPack(bundle);
    expect(v.ok).toBe(false);
  });
});
