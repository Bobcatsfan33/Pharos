import { describe, expect, it } from "vitest";
import { actionRecordToOcsf } from "@pharos/observability";
import type { ActionRecord } from "@pharos/core";

const record: ActionRecord = {
  content: {
    schemaVersion: "1.1.0",
    id: "123e4567-e89b-42d3-a456-426614174000",
    tenantId: "tenant-a",
    sequence: 7,
    action: {
      type: "payment.transfer",
      agentId: "treasury-agent",
      sessionId: "session-1",
      payload: { account: "sensitive-account", amount: 30_000 },
      emittedAt: "2026-08-20T12:00:00.000Z",
    },
    verdict: {
      decision: "block",
      tierReached: 1,
      ruleCitations: [{ ruleId: "limit", pack: "payments", clause: "maxAmount" }],
      riskScore: 0.92,
      failMode: null,
      judgeVersion: null,
      latency: { totalMs: 2, perTier: { "1": 2 }, deadlineMs: 800, deadlineBreached: false },
    },
    liability: {
      mandate: {
        id: "mandate-1",
        scope: "payments",
        limits: { maxAmount: 25_000 },
        grantor: "cfo",
        expiresAt: null,
        version: "1",
      },
      oversightMode: "human_on_loop",
      blastRadius: {
        financialAmount: 30_000,
        currency: "USD",
        reversibility: "irreversible",
      },
      modelMetadata: null,
    },
    sealedAt: "2026-08-20T12:00:00.010Z",
  },
  seal: {
    contentHash: "a".repeat(64),
    prevHash: "b".repeat(64),
    algorithm: "ed25519",
    keyId: "local:key-1",
    signature: "signature",
    sigVersion: 2,
  },
};

describe("OCSF export", () => {
  it("maps a verdict to a complete OCSF 1.9 Base Event without copying payloads", () => {
    const event = actionRecordToOcsf(record, { productVersion: "0.3.0" });
    expect(event).toMatchObject({
      class_uid: 0,
      category_uid: 0,
      activity_id: 99,
      type_uid: 99,
      action_id: 2,
      action: "Denied",
      severity_id: 5,
      status_id: 1,
      metadata: { version: "1.9.0", original_event_uid: record.content.id },
    });
    expect(event.unmapped.pharos.custody.content_hash).toBe(record.seal.contentHash);
    expect(event.unmapped.pharos).not.toHaveProperty("action_payload");
    expect(JSON.stringify(event)).not.toContain("sensitive-account");
  });

  it("includes payload only through an explicit opt-in", () => {
    const event = actionRecordToOcsf(record, { includePayload: true });
    expect(event.unmapped.pharos.action_payload).toEqual(record.content.action.payload);
  });
});
