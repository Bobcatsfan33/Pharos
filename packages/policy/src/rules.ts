import type { VerdictRequest, VerdictDecision, RuleCitation } from "@pharos/core";

/**
 * Declarative, JSON-serializable policy rules — so a regulation pack is a versioned, signed
 * artifact, and a compiled natural-language policy is just data. A rule's condition can test
 * deterministic fields (action type, blast radius, mandate) AND semantic judge probabilities,
 * which unifies the cascade's deterministic and served-model tiers behind one rule model.
 */
export type Comparator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "startsWith" | "contains";

export interface FieldCondition {
  field: string; // dotted path into { action, liability }
  op: Comparator;
  value: unknown;
}
export interface JudgeCondition {
  judge: string; // pack id whose model probability to test
  gte: number;
}
export type Condition =
  | FieldCondition
  | JudgeCondition
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface PolicyRule {
  ruleId: string;
  pack: string;
  /** Regulatory clause this rule enforces (citation-level). */
  clause?: string;
  /** Examiner-readable explanation rendered into the verdict. */
  description: string;
  when: Condition;
  decision: Exclude<VerdictDecision, "allow">;
  /** Compiler confidence (0–1) when the rule was machine-generated; 1 for authored packs. */
  confidence?: number;
}

export interface PolicyArtifact {
  packId: string;
  version: string;
  title: string;
  rules: PolicyRule[];
  changelog?: string;
}

export interface EvalContext {
  request: VerdictRequest;
  /** Judge probabilities by pack id (supplied by the cascade's Tier-3 results). */
  judgeProbabilities: Record<string, number>;
}

function getField(ctx: EvalContext, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = { action: ctx.request.action, liability: ctx.request.liability };
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

function compare(actual: unknown, op: Comparator, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "startsWith":
      return typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected);
    case "contains":
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
  }
}

export function evalCondition(cond: Condition, ctx: EvalContext): boolean {
  if ("all" in cond) return cond.all.every((c) => evalCondition(c, ctx));
  if ("any" in cond) return cond.any.some((c) => evalCondition(c, ctx));
  if ("not" in cond) return !evalCondition(cond.not, ctx);
  if ("judge" in cond) return (ctx.judgeProbabilities[cond.judge] ?? 0) >= cond.gte;
  return compare(getField(ctx, cond.field), cond.op, cond.value);
}

export interface RuleMatch {
  decision: Exclude<VerdictDecision, "allow">;
  citation: RuleCitation;
}

/** Evaluate all rules in an artifact; return the matches (with examiner-readable citations). */
export function evaluateArtifact(artifact: PolicyArtifact, ctx: EvalContext): RuleMatch[] {
  const matches: RuleMatch[] = [];
  for (const rule of artifact.rules) {
    if (!evalCondition(rule.when, ctx)) continue;
    matches.push({
      decision: rule.decision,
      citation: { ruleId: rule.ruleId, pack: rule.pack, clause: rule.clause, description: rule.description },
    });
  }
  return matches;
}
