import { describe, expect, it } from "vitest";
import {
  GOVERNED_ACTION_PROTOCOL_VERSION,
  runGovernedActionConformance,
  validateGovernedActionExchange,
  type GovernedActionExchange,
} from "@getpharos/pdp-spec";

const hash = "a".repeat(64);
const exchange: GovernedActionExchange = {
  envelope: {
    protocolVersion: GOVERNED_ACTION_PROTOCOL_VERSION,
    id: "action-1",
    tenantId: "acme",
    idempotencyKey: "once-1",
    requestedAt: "2026-01-01T00:00:00.000Z",
    request: {
      action: { type: "email.send", agentId: "agent-1" },
      liability: { oversightMode: "human_on_loop", blastRadius: { reversibility: "reversible" } },
    },
    delegationChain: [
      {
        principalId: "alice",
        delegateId: "agent-1",
        scopes: ["email.send"],
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  },
  verdict: {
    specVersion: "1.0.0",
    decision: "allow",
    tierReached: 1,
    riskScore: 0.1,
    ruleCitations: [],
    failMode: null,
    judgeVersion: null,
    latency: { totalMs: 10, deadlineMs: 800, deadlineBreached: false },
    evidenceBinding: {
      algorithm: "ed25519",
      contentHash: hash,
      keyId: "key#v1",
      signature: "c2ln",
    },
  },
  receipt: {
    protocolVersion: GOVERNED_ACTION_PROTOCOL_VERSION,
    actionId: "action-1",
    authorizationRecordId: "record-1",
    authorizationContentHash: hash,
    executorId: "connector:http",
    state: "verified",
    externalId: "remote-1",
    outputDigest: null,
    occurredAt: "2026-01-01T00:01:00.000Z",
  },
};

describe("open governed-action protocol", () => {
  it("certifies a complete vendor-neutral authorization-to-effect exchange", () => {
    expect(runGovernedActionConformance(exchange).passed).toBe(true);
  });

  it("refuses receipts detached from signed authorization evidence", () => {
    const tampered = structuredClone(exchange);
    tampered.receipt!.authorizationContentHash = "b".repeat(64);
    const result = validateGovernedActionExchange(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "receipt authorization hash does not match the verdict evidence binding",
    );
  });

  it("refuses an external effect after a blocking decision", () => {
    const blocked = structuredClone(exchange);
    blocked.verdict.decision = "block";
    expect(validateGovernedActionExchange(blocked).errors).toContain(
      "a block verdict cannot have an execution receipt",
    );
  });

  it("accepts AWS KMS evidence and rejects delegation that misses the acting agent", () => {
    const ecdsa = structuredClone(exchange);
    ecdsa.verdict.evidenceBinding!.algorithm = "ecdsa-p256";
    expect(validateGovernedActionExchange(ecdsa).valid).toBe(true);

    const detached = structuredClone(exchange);
    detached.envelope.delegationChain![0]!.delegateId = "different-agent";
    expect(validateGovernedActionExchange(detached).errors).toContain(
      "delegation chain does not terminate at the acting agent",
    );
  });
});
