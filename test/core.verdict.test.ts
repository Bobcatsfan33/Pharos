import { describe, it, expect } from "vitest";
import { VerdictEngine, type VerdictRequest } from "@pharos/core";

const engine = new VerdictEngine({ deadlineMs: 800, blockedActionTypes: ["system.shutdown"] });
const now = new Date("2026-03-01T00:00:00.000Z");

function req(over: Partial<VerdictRequest> = {}): VerdictRequest {
  return {
    tenantId: "t1",
    action: { type: "email.send", agentId: "a1", payload: {}, emittedAt: now.toISOString() },
    liability: {
      mandate: null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
    },
    ...over,
  };
}

describe("VerdictEngine (Tier 1)", () => {
  it("allows a benign action", () => {
    const v = engine.evaluate(req(), now);
    expect(v.decision).toBe("allow");
    expect(v.tierReached).toBe(1);
  });

  it("blocks an action exceeding the mandate monetary limit", () => {
    const v = engine.evaluate(
      req({
        action: {
          type: "payment.transfer",
          agentId: "a1",
          payload: { amount: 30000 },
          emittedAt: now.toISOString(),
        },
        liability: {
          mandate: {
            id: "m1",
            scope: "payments",
            limits: { maxAmount: 25000 },
            grantor: "cfo",
            expiresAt: null,
            version: "1",
          },
          oversightMode: "human_in_loop",
          blastRadius: { financialAmount: 30000, currency: "USD", reversibility: "irreversible" },
          modelMetadata: null,
        },
      }),
      now,
    );
    expect(v.decision).toBe("block");
    expect(v.riskScore).toBe(1);
    expect(v.ruleCitations.some((c) => c.ruleId === "mandate-limit-exceeded")).toBe(true);
  });

  it("escalates when the mandate is expired", () => {
    const v = engine.evaluate(
      req({
        liability: {
          mandate: {
            id: "m1",
            scope: "x",
            limits: {},
            grantor: "cfo",
            expiresAt: "2026-01-01T00:00:00.000Z",
            version: "1",
          },
          oversightMode: "autonomous",
          blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
          modelMetadata: null,
        },
      }),
      now,
    );
    expect(v.decision).toBe("escalate");
    expect(v.ruleCitations.some((c) => c.ruleId === "mandate-expired")).toBe(true);
  });

  it("blocks deny-listed action types", () => {
    const v = engine.evaluate(
      req({
        action: {
          type: "system.shutdown",
          agentId: "a1",
          payload: {},
          emittedAt: now.toISOString(),
        },
      }),
      now,
    );
    expect(v.decision).toBe("block");
  });

  it("escalates irreversible non-autonomous actions", () => {
    const v = engine.evaluate(
      req({
        liability: {
          mandate: null,
          oversightMode: "human_on_loop",
          blastRadius: { financialAmount: 500, currency: "USD", reversibility: "irreversible" },
          modelMetadata: null,
        },
      }),
      now,
    );
    expect(v.decision).toBe("escalate");
    expect(v.ruleCitations.some((c) => c.ruleId === "irreversible-oversight")).toBe(true);
  });

  it("records latency within the budget", () => {
    const v = engine.evaluate(req(), now);
    expect(v.latency.deadlineMs).toBe(800);
    expect(v.latency.totalMs).toBeGreaterThanOrEqual(0);
    expect(v.latency.deadlineBreached).toBe(false);
  });
});
