import { describe, expect, it } from "vitest";
import type { ActionIntent, LiabilityContext, MandateBinding } from "@pharos/core";
import {
  STRUCTURAL_JUDGE_VERSION,
  StructuralJudge,
  checkBlastRadius,
  checkMandateScope,
  checkPayloadSchema,
  checkPlan,
  deadlineFrom,
  validateObject,
  type JudgeInput,
} from "@pharos/judge";

/**
 * The structural judge (D1): deterministic, model-free checks. Each check fails only when the
 * tenant stated the fact it relies on and the action contradicts it; otherwise it abstains.
 */
const action = (type: string, payload: Record<string, unknown> = {}): ActionIntent => ({
  type,
  agentId: "a",
  payload,
  emittedAt: "2026-10-29T00:00:00.000Z",
});
const liability = (over: Partial<LiabilityContext["blastRadius"]> = {}): LiabilityContext => ({
  mandate: null,
  oversightMode: "autonomous",
  blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible", ...over },
  modelMetadata: null,
});
const mandate = (limits: Record<string, unknown>): MandateBinding => ({
  id: "m-1",
  scope: "vendor payments",
  limits,
  grantor: "cfo",
  expiresAt: null,
  version: "1",
});
const input = (
  a: ActionIntent,
  l: LiabilityContext,
  extra: Partial<JudgeInput> = {},
): JudgeInput => ({
  action: a,
  liability: l,
  context: { tenantId: "t" },
  mandate: l.mandate,
  textVariants: [],
  priorSignals: [],
  ...extra,
});

describe("structural judge — mandate scope", () => {
  it("abstains without a mandate or without declared action types", () => {
    expect(checkMandateScope(action("payment.transfer"), null).abstain).toBe(true);
    expect(checkMandateScope(action("payment.transfer"), mandate({ maxAmount: 1 })).abstain).toBe(
      true,
    );
  });
  it("passes an action inside the declared prefixes and fails one outside", () => {
    const m = mandate({ actionTypes: ["payment.", "invoice.read"] });
    expect(checkMandateScope(action("payment.transfer"), m)).toMatchObject({
      score: 0,
      abstain: false,
    });
    expect(checkMandateScope(action("invoice.read"), m).score).toBe(0);
    expect(checkMandateScope(action("crm.update"), m)).toMatchObject({
      score: 1,
      citation: "structural-mandate-scope",
    });
  });
});

describe("structural judge — mandate scope from a verified token (#300)", () => {
  const stored = mandate({ actionTypes: ["payment.", "invoice.read"] });
  const tokenFor = (actionTypes: string[], verification = "verified") => ({
    verification,
    effective: { mandateId: "m-1", scope: { actionTypes } },
  });

  it("a token narrower than the stored mandate governs: an action the mandate allows is flagged", () => {
    // The stored mandate permits every `payment.` action; the holder attenuated the token to
    // `payment.transfer` only. Tier 1 enforces the narrowed scope, and so must this check.
    expect(checkMandateScope(action("payment.refund"), stored)).toMatchObject({
      score: 0,
      abstain: false,
    });
    const narrowed = checkMandateScope(
      action("payment.refund"),
      stored,
      tokenFor(["payment.transfer"]),
    );
    expect(narrowed).toMatchObject({ score: 1, citation: "structural-mandate-scope" });
    expect(narrowed.rationale).toMatch(/mandate token for m-1/);
    // In scope for the token: passes.
    expect(
      checkMandateScope(action("payment.transfer"), stored, tokenFor(["payment.transfer"])).score,
    ).toBe(0);
  });

  it("the token governs even when the binding carries no action types at all", () => {
    // A token-derived MandateBinding has limits {maxAmount, currency}, never actionTypes —
    // which is exactly the case that used to abstain.
    const tokenBinding = mandate({ maxAmount: 5000, currency: "USD" });
    expect(checkMandateScope(action("crm.update"), tokenBinding).abstain).toBe(true);
    expect(
      checkMandateScope(action("crm.update"), tokenBinding, tokenFor(["payment."])),
    ).toMatchObject({ score: 1, citation: "structural-mandate-scope" });
  });

  it("a refused token contributes no scope — Tier 1 has already blocked it", () => {
    for (const verification of ["proof", "widening", "expired", "mandate-revoked"]) {
      const f = checkMandateScope(
        action("crm.update"),
        stored,
        tokenFor(["payment."], verification),
      );
      // Falls back to the stored mandate, which does not cover crm.update.
      expect(f.rationale, verification).toMatch(/mandate m-1/);
    }
  });

  it("no token leaves the previous behaviour byte-identical", () => {
    for (const a of ["payment.transfer", "invoice.read", "crm.update"]) {
      expect(checkMandateScope(action(a), stored, undefined)).toEqual(
        checkMandateScope(action(a), stored),
      );
    }
    expect(checkMandateScope(action("payment.transfer"), null, undefined).abstain).toBe(true);
    // A verified token with an empty scope list abstains rather than failing everything.
    expect(checkMandateScope(action("x"), null, tokenFor([])).abstain).toBe(true);
  });
});

describe("structural judge — payload schema", () => {
  const schema = {
    type: "object" as const,
    required: ["amount", "to"],
    properties: {
      amount: { type: "number" as const, minimum: 0 },
      to: { type: "string" as const },
      currency: { type: "string" as const, enum: ["USD", "EUR"] },
      count: { type: "integer" as const },
    },
    additionalProperties: false,
  };
  it("abstains when the tenant registered no schema for the type", () => {
    expect(checkPayloadSchema(action("payment.transfer", { amount: 1 }), undefined).abstain).toBe(
      true,
    );
  });
  it("validates required keys, types, enums, bounds, integers, and extra keys", () => {
    expect(validateObject({ amount: 5, to: "x" }, schema)).toEqual([]);
    expect(
      validateObject({ amount: -1, to: "x", currency: "GBP", count: 1.5, extra: 1 }, schema),
    ).toEqual([
      '"amount" below minimum 0',
      '"currency" not in ["USD","EUR"]',
      '"count" should be an integer',
      'unexpected "extra"',
    ]);
    expect(validateObject({ to: 5 }, schema)).toEqual([
      'missing required "amount"',
      '"to" should be string, got number',
    ]);
    expect(validateObject("nope", schema)).toEqual(["payload is not an object"]);
  });
  it("fails the check with a citation when the payload does not match", () => {
    expect(checkPayloadSchema(action("payment.transfer", { to: "x" }), schema)).toMatchObject({
      score: 1,
      citation: "structural-payload-schema",
    });
  });
});

describe("structural judge — plan", () => {
  it("abstains without a plan, passes an allowed next step, fails a deviation", () => {
    expect(checkPlan(action("file.read"), undefined).abstain).toBe(true);
    expect(checkPlan(action("file.read"), { allowedNext: ["file.", "git.status"] }).score).toBe(0);
    expect(
      checkPlan(action("payment.transfer"), { allowedNext: ["file.", "git.status"] }),
    ).toMatchObject({
      score: 1,
      citation: "structural-plan-deviation",
    });
  });
});

describe("structural judge — blast radius", () => {
  it("abstains when the payload declares nothing comparable", () => {
    expect(
      checkBlastRadius(
        input(action("crm.update", { record: "x" }), liability({ reversibility: "irreversible" })),
      ).abstain,
    ).toBe(true);
  });
  it("fails on an amount or currency that contradicts the declaration", () => {
    const f = checkBlastRadius(
      input(
        action("payment.transfer", { amount: 9800, currency: "EUR" }),
        liability({ financialAmount: 100, currency: "USD", reversibility: "irreversible" }),
      ),
    );
    expect(f.score).toBe(1);
    expect(f.rationale).toMatch(/9800 ≠ declared financialAmount 100/);
    expect(f.rationale).toMatch(/EUR ≠ declared USD/);
  });
  it("passes a consistent declaration and abstains on an outbound action with no money", () => {
    expect(
      checkBlastRadius(
        input(
          action("payment.transfer", { amount: 4800 }),
          liability({ financialAmount: 4800, reversibility: "irreversible" }),
        ),
      ),
    ).toMatchObject({ score: 0, abstain: false });
    // Reversibility is a declaration, not a payload fact: a reversible payment is not contradicted
    // by its own amount, and an email with no money gives the check nothing to compare.
    expect(
      checkBlastRadius(
        input(
          action("payment.transfer", { amount: 4800 }),
          liability({ financialAmount: 4800, reversibility: "reversible" }),
        ),
      ).score,
    ).toBe(0);
    expect(checkBlastRadius(input(action("email.send", { body: "hi" }), liability())).abstain).toBe(
      true,
    );
  });
});

describe("structural judge — a token turns an abstention into a real check (#300)", () => {
  it("abstains for a token-derived binding without the token, and checks with it", async () => {
    const judge = new StructuralJudge();
    const dl = deadlineFrom(process.hrtime.bigint(), 800);
    // A token-derived binding: limits carry money, never action types.
    const binding = mandate({ maxAmount: 5000, currency: "USD" });
    const base = input(action("payment.transfer", { record: "x" }), liability(), {
      mandate: binding,
    });
    // Without the sealed token the scope check has nothing to read, so the whole judge abstains:
    // "no structural citation" did NOT mean "the scope was verified".
    expect((await judge.evaluate(base, dl)).abstain).toBe(true);

    // With the verified token it is a real check that passes — the judge no longer abstains.
    const withToken = await judge.evaluate(
      {
        ...base,
        liability: {
          ...base.liability,
          mandateToken: {
            verification: "verified",
            effective: { mandateId: "m-1", scope: { actionTypes: ["payment."] } },
          },
        } as typeof base.liability,
      },
      dl,
    );
    expect(withToken.abstain).toBe(false);
    expect(withToken.score).toBe(0);
    expect(withToken.rationale).toMatch(/structural\.mandate-scope: ok/);
  });
});

describe("structural judge — panel result", () => {
  it("reports the most severe fired check, abstains when nothing applied, and carries a content-hashed version", async () => {
    const judge = new StructuralJudge();
    const dl = deadlineFrom(process.hrtime.bigint(), 800);
    const none = await judge.evaluate(
      input(action("crm.update", { record: "x" }), liability()),
      dl,
    );
    expect(none).toMatchObject({
      kind: "structural",
      abstain: true,
      score: 0,
      shadow: false,
      confidence: 1,
    });
    const fired = await judge.evaluate(
      input(
        action("payment.transfer", { amount: 5 }),
        liability({ financialAmount: 1, reversibility: "irreversible" }),
        { mandate: mandate({ actionTypes: ["email."] }) },
      ),
      dl,
    );
    expect(fired.abstain).toBe(false);
    expect(fired.score).toBe(1);
    expect(["structural.mandate-scope", "structural.blast-radius"]).toContain(fired.concern);
    expect(fired.rationale).toMatch(/structural\.mandate-scope: FAIL/);
    expect(fired.rationale).toMatch(/structural\.blast-radius: FAIL/);
    expect(fired.judgeVersion).toBe(STRUCTURAL_JUDGE_VERSION);
    expect(STRUCTURAL_JUDGE_VERSION).toMatch(/^structural@[0-9a-f]{12}$/);
    expect(fired.latencyMs).toBeLessThan(20);
  });
});
