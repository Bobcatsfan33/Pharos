import { sha256Hex, type ActionIntent, type MandateBinding } from "@pharos/core";
import {
  type ActionSchema,
  type Deadline,
  type Judge,
  type JudgeInput,
  type PanelJudgeResult,
  type PropertySchema,
  actionTypeMatches,
} from "./contract.js";

/**
 * The structural judge (D1): deterministic checks that need no model, so they are promotable
 * immediately and run on every action in microseconds.
 *
 *   structural.mandate-scope     action type ∈ the mandate's declared action types
 *   structural.payload-schema    payload validates against the tenant's schema for the type
 *   structural.plan              the call is one the current plan allows next
 *   structural.blast-radius      declared blast radius is consistent with the payload
 *
 * A check whose facts are absent ABSTAINS (score 0, abstain true) rather than inventing a pass
 * or a fail: no declared scope, no schema for the type, no plan, no amount in the payload. The
 * verdict therefore only changes when a tenant has stated the fact the check relies on.
 */
export const STRUCTURAL_CHECKS = [
  "structural.mandate-scope",
  "structural.payload-schema",
  "structural.plan",
  "structural.blast-radius",
] as const;
export type StructuralCheck = (typeof STRUCTURAL_CHECKS)[number];

/** Bumped whenever a check's semantics change; the content hash makes the version self-describing. */
const STRUCTURAL_SEMANTICS_VERSION = "2";
export const STRUCTURAL_JUDGE_VERSION = `structural@${sha256Hex({
  semantics: STRUCTURAL_SEMANTICS_VERSION,
  checks: STRUCTURAL_CHECKS,
}).slice(0, 12)}`;

/** Payload keys that declare money, in order of preference. */
const AMOUNT_KEYS = ["financialAmount", "amount", "total", "value"];
const CURRENCY_KEYS = ["currency", "ccy"];

export class StructuralJudge implements Judge {
  readonly kind = "structural" as const;
  readonly id = "structural";

  appliesTo(): boolean {
    return true;
  }

  async evaluate(input: JudgeInput, _deadline: Deadline): Promise<PanelJudgeResult> {
    void _deadline; // sub-millisecond; the panel's deadline is enforced around us
    const start = process.hrtime.bigint();
    const findings = [
      checkMandateScope(input.action, input.mandate),
      checkPayloadSchema(input.action, input.context.actionSchemas?.[input.action.type]),
      checkPlan(input.action, input.context.plan),
      checkBlastRadius(input),
    ];
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    // Report the most severe finding; the full list rides in the rationale so evidence stays complete.
    const fired = findings.filter((f) => !f.abstain && f.score > 0);
    const applicable = findings.filter((f) => !f.abstain);
    const top = fired.sort((a, b) => b.score - a.score)[0];
    return {
      kind: "structural",
      concern: top?.concern ?? "structural",
      score: top?.score ?? 0,
      confidence: 1,
      abstain: applicable.length === 0,
      ...(top?.citation ? { citation: top.citation } : {}),
      rationale: findings
        .map(
          (f) =>
            `${f.concern}: ${f.abstain ? "n/a" : f.score > 0 ? `FAIL — ${f.rationale}` : "ok"}`,
        )
        .join("; "),
      judgeVersion: STRUCTURAL_JUDGE_VERSION,
      latencyMs,
      shadow: false,
    };
  }

  /** Every check as its own signal, for policy rules that key on a specific concern. */
  async evaluateAll(input: JudgeInput): Promise<Finding[]> {
    return [
      checkMandateScope(input.action, input.mandate),
      checkPayloadSchema(input.action, input.context.actionSchemas?.[input.action.type]),
      checkPlan(input.action, input.context.plan),
      checkBlastRadius(input),
    ];
  }
}

export interface Finding {
  concern: StructuralCheck;
  score: 0 | 1;
  abstain: boolean;
  citation?: string;
  rationale: string;
}

const ok = (concern: StructuralCheck, rationale = "ok"): Finding => ({
  concern,
  score: 0,
  abstain: false,
  rationale,
});
const na = (concern: StructuralCheck, rationale: string): Finding => ({
  concern,
  score: 0,
  abstain: true,
  rationale,
});
const fail = (concern: StructuralCheck, citation: string, rationale: string): Finding => ({
  concern,
  score: 1,
  abstain: false,
  citation,
  rationale,
});

/** The mandate declares the action types it covers in `limits.actionTypes` (prefix list). */
export function checkMandateScope(action: ActionIntent, mandate: MandateBinding | null): Finding {
  const c = "structural.mandate-scope";
  if (!mandate) return na(c, "no mandate bound");
  const declared = mandate.limits?.actionTypes;
  if (!Array.isArray(declared) || declared.length === 0)
    return na(c, "mandate declares no action types");
  const prefixes = declared.filter((d): d is string => typeof d === "string");
  if (actionTypeMatches(action.type, prefixes)) return ok(c);
  return fail(
    c,
    "structural-mandate-scope",
    `action type ${action.type} is outside mandate ${mandate.id}'s declared scope (${prefixes.join(", ")})`,
  );
}

export function checkPayloadSchema(
  action: ActionIntent,
  schema: ActionSchema | undefined,
): Finding {
  const c = "structural.payload-schema";
  if (!schema) return na(c, "no schema registered for this action type");
  const errors = validateObject(action.payload, schema);
  if (errors.length === 0) return ok(c);
  return fail(
    c,
    "structural-payload-schema",
    `payload does not match the ${action.type} schema: ${errors.join("; ")}`,
  );
}

export function checkPlan(action: ActionIntent, plan: JudgeInput["context"]["plan"]): Finding {
  const c = "structural.plan";
  if (!plan) return na(c, "no plan supplied");
  if (actionTypeMatches(action.type, plan.allowedNext)) return ok(c);
  return fail(
    c,
    "structural-plan-deviation",
    `action type ${action.type} is not an allowed next step of the current plan (${plan.allowedNext.join(", ") || "none"})`,
  );
}

export function checkBlastRadius(input: JudgeInput): Finding {
  const c = "structural.blast-radius";
  const { action, liability } = input;
  const declaredAmount = liability.blastRadius.financialAmount;
  const payloadAmount = firstNumber(action.payload, AMOUNT_KEYS);
  const payloadCurrency = firstString(action.payload, CURRENCY_KEYS);
  // Nothing to compare: the check only speaks when the payload states an amount or a currency.
  // Reversibility is a declaration about the world, not a payload fact, so it is not second-guessed here.
  if (payloadAmount === null && payloadCurrency === null) {
    return na(c, "payload declares no amount or currency to compare");
  }
  const problems: string[] = [];
  if (payloadAmount !== null && Math.abs(payloadAmount - declaredAmount) > 0.005) {
    problems.push(`payload amount ${payloadAmount} ≠ declared financialAmount ${declaredAmount}`);
  }
  if (
    payloadCurrency !== null &&
    payloadCurrency.toUpperCase() !== liability.blastRadius.currency.toUpperCase()
  ) {
    problems.push(
      `payload currency ${payloadCurrency} ≠ declared ${liability.blastRadius.currency}`,
    );
  }
  if (problems.length === 0) return ok(c);
  return fail(c, "structural-blast-radius", problems.join("; "));
}

function firstNumber(payload: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  }
  return null;
}
function firstString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** A deliberately small JSON-schema subset: enough to say "this payload is not the shape the type promised". */
export function validateObject(value: unknown, schema: ActionSchema): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return ["payload is not an object"];
  const obj = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj) || obj[key] === undefined) errors.push(`missing required "${key}"`);
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!(key in obj) || obj[key] === undefined) continue;
    errors.push(...validateProperty(key, obj[key], prop));
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in (schema.properties ?? {}))) errors.push(`unexpected "${key}"`);
    }
  }
  return errors;
}

function validateProperty(key: string, v: unknown, prop: PropertySchema): string[] {
  const errors: string[] = [];
  if (prop.type) {
    const actual = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    const want = prop.type === "integer" ? "number" : prop.type;
    if (actual !== want) errors.push(`"${key}" should be ${prop.type}, got ${actual}`);
    else if (prop.type === "integer" && !Number.isInteger(v))
      errors.push(`"${key}" should be an integer`);
  }
  if (prop.enum && !prop.enum.some((e) => e === v))
    errors.push(`"${key}" not in ${JSON.stringify(prop.enum)}`);
  if (typeof v === "number") {
    if (prop.minimum !== undefined && v < prop.minimum)
      errors.push(`"${key}" below minimum ${prop.minimum}`);
    if (prop.maximum !== undefined && v > prop.maximum)
      errors.push(`"${key}" above maximum ${prop.maximum}`);
  }
  return errors;
}
