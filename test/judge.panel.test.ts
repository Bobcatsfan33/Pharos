import { describe, expect, it } from "vitest";
import { VerdictEngine, type VerdictRequest } from "@pharos/core";
import {
  ModelRegistry,
  loadDefaultRegistry,
  type AsyncJudge,
  type JudgeResult,
} from "@pharos/judge";
import { DEFAULT_PACK_BINDINGS, VerdictCascade, type JudgePackBinding } from "@pharos/cascade";

/**
 * D1 panel behaviour at the cascade boundary: routing (a content model never runs for an action
 * type outside its binding), concurrency (three slow models cost max, not sum), and per-judge
 * timings sealed as `perTier["3/<judge>"]` beside the tier totals.
 */
const now = new Date("2026-10-29T00:00:00.000Z");
const req = (
  type: string,
  payload: Record<string, unknown> = {},
  over: Partial<VerdictRequest["liability"]> = {},
): VerdictRequest => ({
  tenantId: "t",
  action: { type, agentId: "a", payload, emittedAt: now.toISOString() },
  liability: {
    mandate: null,
    oversightMode: "human_on_loop",
    blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
    modelMetadata: null,
    ...over,
  },
});

/** A served judge that takes `delayMs` and reports a fixed probability — for timing assertions. */
function slowJudge(packId: string, delayMs: number, probability = 0.1): AsyncJudge {
  return {
    packId,
    concern: packId,
    version: () => `${packId}@slow`,
    async scoreBatch(texts: string[]): Promise<JudgeResult[]> {
      await new Promise((r) => setTimeout(r, delayMs));
      return texts.map(() => ({
        packId,
        concern: packId,
        judgeVersion: `${packId}@slow`,
        probability,
        flagged: probability >= 0.5,
        threshold: 0.5,
      }));
    },
  };
}

describe("judge panel — routing", () => {
  const cascade = new VerdictCascade({
    engine: new VerdictEngine({ deadlineMs: 800 }),
    registry: loadDefaultRegistry(),
    deadlineMs: 800,
    packs: DEFAULT_PACK_BINDINGS,
  });

  it("runs no content model for crm.update, but still runs the structural judge", async () => {
    const v = await cascade.evaluate(
      req("crm.update", { record: "lead-42", body: "We guarantee a 20% return" }),
      now,
    );
    expect(v.tierReached).toBe(3);
    expect(v.decision).toBe("allow"); // promissory text in a CRM note is not a FINRA communication
    expect(Object.keys(v.latency.perTier).filter((k) => k.startsWith("3/"))).toEqual([
      "3/structural",
    ]);
    expect(v.judgeVersion).toBeNull();
  });

  it("runs the communications models for email.send and the funds model for payment.transfer", async () => {
    const email = await cascade.evaluate(
      req("email.send", { body: "Thanks, statement attached." }),
      now,
    );
    expect(
      Object.keys(email.latency.perTier)
        .filter((k) => k.startsWith("3/"))
        .sort(),
    ).toEqual(["3/finra-promissory", "3/phi-in-context", "3/structural"]);
    const pay = await cascade.evaluate(
      req(
        "payment.transfer",
        { amount: 100, memo: "wire the funds" },
        { blastRadius: { financialAmount: 100, currency: "USD", reversibility: "irreversible" } },
      ),
      now,
    );
    expect(
      Object.keys(pay.latency.perTier)
        .filter((k) => k.startsWith("3/"))
        .sort(),
    ).toEqual(["3/funds-movement-intent", "3/structural"]);
  });

  it("routing: all restores the pre-D1 behaviour (every model on every action)", async () => {
    const all = new VerdictCascade({
      engine: new VerdictEngine({ deadlineMs: 800 }),
      registry: loadDefaultRegistry(),
      deadlineMs: 800,
      packs: DEFAULT_PACK_BINDINGS,
      routing: "all",
    });
    const v = await all.evaluate(req("crm.update", { body: "We guarantee a 20% return" }), now);
    expect(
      Object.keys(v.latency.perTier)
        .filter((k) => k.startsWith("3/"))
        .sort(),
    ).toEqual([
      "3/finra-promissory",
      "3/funds-movement-intent",
      "3/phi-in-context",
      "3/structural",
    ]);
  });

  it("tier totals exclude the per-judge keys, so totalMs is not double-counted", async () => {
    const v = await cascade.evaluate(req("email.send", { body: "hi" }), now);
    const tiers = ["1", "2", "3"].reduce((s, k) => s + (v.latency.perTier[k] ?? 0), 0);
    expect(v.latency.totalMs).toBeCloseTo(tiers, 6);
    for (const k of Object.keys(v.latency.perTier))
      expect(typeof v.latency.perTier[k]).toBe("number");
  });
});

describe("judge panel — concurrency", () => {
  it("three slow models cost max(model), not sum(model), and each is timed", async () => {
    const registry = new ModelRegistry();
    const packs: JudgePackBinding[] = DEFAULT_PACK_BINDINGS.map((b) => ({
      ...b,
      actionTypes: ["email."],
    }));
    for (const b of packs) registry.registerServed(slowJudge(b.packId, 60));
    const cascade = new VerdictCascade({
      engine: new VerdictEngine({ deadlineMs: 800 }),
      registry,
      deadlineMs: 800,
      packs,
    });
    const start = process.hrtime.bigint();
    const v = await cascade.evaluate(req("email.send", { body: "hi" }), now);
    const wall = Number(process.hrtime.bigint() - start) / 1e6;
    expect(v.tierReached).toBe(3);
    const judgeMs = Object.entries(v.latency.perTier)
      .filter(([k]) => k.startsWith("3/") && k !== "3/structural")
      .map(([, ms]) => ms);
    expect(judgeMs).toHaveLength(3);
    const sum = judgeMs.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThanOrEqual(3 * 55);
    expect(v.latency.perTier["3"]).toBeLessThan(sum * 0.6); // concurrent: ≈ max(60) + overhead, far below 180
    expect(wall).toBeLessThan(sum * 0.8);
  });
});

describe("judge panel — structural decisions", () => {
  const cascade = new VerdictCascade({
    engine: new VerdictEngine({ deadlineMs: 800 }),
    registry: loadDefaultRegistry(),
    deadlineMs: 800,
    packs: DEFAULT_PACK_BINDINGS,
  });

  it("a mandate that declares action types blocks an action outside them, citing the structural rule", async () => {
    const v = await cascade.evaluate(
      req(
        "crm.update",
        { record: "x" },
        {
          mandate: {
            id: "m",
            scope: "payments only",
            limits: { actionTypes: ["payment."] },
            grantor: "cfo",
            expiresAt: null,
            version: "1",
          },
        },
      ),
      now,
    );
    expect(v.decision).toBe("block");
    expect(v.ruleCitations.map((c) => c.ruleId)).toContain("structural-mandate-scope");
    expect(v.judgeVersion).toMatch(/^structural@/);
  });

  it("a declared blast radius that contradicts the payload escalates", async () => {
    const v = await cascade.evaluate(
      req(
        "crm.update",
        { amount: 500, currency: "EUR" },
        { blastRadius: { financialAmount: 0, currency: "USD", reversibility: "irreversible" } },
      ),
      now,
    );
    expect(v.decision).toBe("escalate");
    expect(v.ruleCitations.map((c) => c.ruleId)).toContain("structural-blast-radius");
  });

  it("structural signals are addressable by policy rules as judge conditions", async () => {
    const v = await cascade.evaluate(req("crm.update", { record: "x" }), now, [
      {
        packId: "t",
        version: "1",
        title: "plan",
        rules: [
          {
            ruleId: "plan-only",
            pack: "t",
            description: "deviation",
            when: { judge: "structural.plan", gte: 1 },
            decision: "escalate",
          },
        ],
      },
    ]);
    expect(v.decision).toBe("allow"); // no plan supplied → the check abstains → the rule sees no signal
    const withPlan = new VerdictCascade({
      engine: new VerdictEngine({ deadlineMs: 800 }),
      registry: loadDefaultRegistry(),
      deadlineMs: 800,
      packs: DEFAULT_PACK_BINDINGS,
      contextFor: () => ({ tenantId: "t", plan: { allowedNext: ["file."] } }),
    });
    const d = await withPlan.evaluate(req("crm.update", { record: "x" }), now);
    expect(d.decision).toBe("escalate");
    expect(d.ruleCitations.map((c) => c.ruleId)).toContain("structural-plan-deviation");
  });

  it("structural: false removes the structural judge from the panel", async () => {
    const off = new VerdictCascade({
      engine: new VerdictEngine({ deadlineMs: 800 }),
      registry: loadDefaultRegistry(),
      deadlineMs: 800,
      packs: DEFAULT_PACK_BINDINGS,
      structural: false,
    });
    const v = await off.evaluate(
      req(
        "crm.update",
        { amount: 500 },
        { blastRadius: { financialAmount: 0, currency: "USD", reversibility: "irreversible" } },
      ),
      now,
    );
    expect(v.decision).toBe("allow");
    expect(v.latency.perTier["3/structural"]).toBeUndefined();
  });
});
