import { describe, it, expect } from "vitest";
import { VerdictEngine, type VerdictRequest, type LiabilityContext } from "@pharos/core";
import { loadDefaultRegistry, ModelRegistry, type AsyncJudge } from "@pharos/judge";
import { VerdictCascade, DEFAULT_PACK_BINDINGS, fingerprintVerdict } from "@pharos/cascade";
// Fault injection lives outside the shipped class (#82) and is reached only by this
// explicit deep import, never from the package index.
import { FaultInjectingCascade, type CascadeFaults } from "@pharos/cascade/testing";

const registry = loadDefaultRegistry();
const now = new Date("2026-04-01T00:00:00.000Z");

function cascade(deadlineMs = 800, faults?: CascadeFaults): VerdictCascade {
  const deps = {
    engine: new VerdictEngine({ deadlineMs }),
    registry,
    deadlineMs,
    packs: DEFAULT_PACK_BINDINGS,
  };
  // Without faults this is the production class verbatim — the same object the server
  // builds — so the unfaulted tests still exercise the shipped code path.
  return faults ? new FaultInjectingCascade(deps, faults) : new VerdictCascade(deps);
}

function req(
  over: {
    type?: string;
    payload?: Record<string, unknown>;
    liability?: Partial<LiabilityContext>;
  } = {},
): VerdictRequest {
  return {
    tenantId: "t1",
    action: {
      type: over.type ?? "email.send",
      agentId: "a1",
      payload: over.payload ?? {},
      emittedAt: now.toISOString(),
    },
    liability: {
      mandate: null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
      ...over.liability,
    },
  };
}

describe("verdict cascade", () => {
  it("allows a benign action and reaches Tier 3 (semantic eval ran)", async () => {
    const v = await cascade().evaluate(
      req({ payload: { body: "Thanks for reaching out, here is your statement." } }),
      now,
    );
    expect(v.decision).toBe("allow");
    expect(v.tierReached).toBe(3);
    expect(v.judgeVersion).toMatch(/@[0-9a-f]{12}$/);
    expect(v.latency.perTier["1"]).toBeGreaterThanOrEqual(0);
    expect(v.latency.perTier["3"]).toBeGreaterThanOrEqual(0);
  });

  it("blocks FINRA promissory language at Tier 3 with a citation", async () => {
    const v = await cascade().evaluate(
      req({
        payload: {
          body: "We guarantee a 20% return with absolutely no risk — guaranteed profits!",
        },
      }),
      now,
    );
    expect(v.decision).toBe("block");
    expect(v.tierReached).toBe(3);
    expect(v.ruleCitations.some((c) => c.ruleId === "finra-2210-promissory")).toBe(true);
    expect(v.judgeVersion).toMatch(/^finra-promissory@/);
  });

  it("escalates PHI exposure at Tier 3", async () => {
    const v = await cascade().evaluate(
      req({
        payload: {
          body: "Patient John Smith was diagnosed with HIV and started antiretroviral therapy.",
        },
      }),
      now,
    );
    expect(v.decision).toBe("escalate");
    expect(v.ruleCitations.some((c) => c.ruleId === "hipaa-phi-exposure")).toBe(true);
  });

  it("escalates unmandated funds-movement intent", async () => {
    const v = await cascade().evaluate(
      req({
        type: "payment.transfer",
        payload: { body: "Wire 9800 dollars to the vendor account immediately." },
      }),
      now,
    );
    expect(["escalate", "block"]).toContain(v.decision);
    expect(v.ruleCitations.some((c) => c.ruleId === "funds-movement-unmandated")).toBe(true);
  });

  it("short-circuits at Tier 1 on a mandate-limit block (later tiers skipped)", async () => {
    const v = await cascade().evaluate(
      req({
        type: "payment.transfer",
        payload: { amount: 30000 },
        liability: {
          mandate: {
            id: "m1",
            scope: "pay",
            limits: { maxAmount: 25000 },
            grantor: "cfo",
            expiresAt: null,
            version: "1",
          },
          blastRadius: { financialAmount: 30000, currency: "USD", reversibility: "irreversible" },
          oversightMode: "human_in_loop",
        },
      }),
      now,
    );
    expect(v.decision).toBe("block");
    expect(v.tierReached).toBe(1);
    expect(v.latency.perTier["3"]).toBeUndefined(); // Tier 3 never ran
  });

  it("fails OPEN on a judge fault for a reversible action", async () => {
    const v = await cascade(800, { judgeThrows: true }).evaluate(
      req({
        liability: {
          blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
        },
      }),
      now,
    );
    expect(v.decision).toBe("allow");
    expect(v.failMode).toBe("fail_open");
    expect(v.ruleCitations.some((c) => c.ruleId === "deadline-fail-open")).toBe(true);
  });

  it("fails CLOSED on a judge fault for an irreversible action", async () => {
    const v = await cascade(800, { judgeThrows: true }).evaluate(
      req({
        liability: {
          blastRadius: { financialAmount: 500, currency: "USD", reversibility: "irreversible" },
        },
      }),
      now,
    );
    expect(v.decision).toBe("escalate");
    expect(v.failMode).toBe("fail_closed");
  });

  it("enforces the deadline: a slow judge triggers fail mode", async () => {
    const v = await cascade(20, { judgeDelayMs: 300 }).evaluate(
      req({ payload: { body: "hello" } }),
      now,
    );
    expect(v.failMode).not.toBeNull();
    expect(v.latency.deadlineBreached).toBe(true);
  });

  it("enforces the deadline after CPU-bound inference starves the timer", async () => {
    const blockingRegistry = new ModelRegistry();
    for (const binding of DEFAULT_PACK_BINDINGS) {
      const judge: AsyncJudge = {
        packId: binding.packId,
        concern: binding.packId,
        version: () => `${binding.packId}@blocking`,
        scoreBatch: async (texts) => {
          const until = performance.now() + 10;
          while (performance.now() < until) {
            // Deliberately occupy the event loop, modeling a saturated native inference return.
          }
          return texts.map(() => ({
            packId: binding.packId,
            concern: binding.packId,
            judgeVersion: `${binding.packId}@blocking`,
            probability: 0,
            flagged: false,
            threshold: 0.5,
          }));
        },
      };
      blockingRegistry.registerServed(judge);
    }
    const c = new VerdictCascade({
      engine: new VerdictEngine({ deadlineMs: 5 }),
      registry: blockingRegistry,
      deadlineMs: 5,
      packs: DEFAULT_PACK_BINDINGS,
    });

    const v = await c.evaluate(req({ payload: { body: "hello" } }), now);
    expect(v.failMode).toBe("fail_open");
    expect(v.latency.deadlineBreached).toBe(true);
    expect(v.latency.totalMs).toBeGreaterThan(5);
  });

  it("is reproducible: identical inputs yield bit-identical verdicts (latency excluded)", async () => {
    const r = req({
      payload: { body: "We guarantee a 20% return with no risk, guaranteed profits!" },
    });
    const fps = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const v = await cascade().evaluate(r, now);
      fps.add(fingerprintVerdict(v));
    }
    expect(fps.size).toBe(1);
  });
});
