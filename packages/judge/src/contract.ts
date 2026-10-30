import type { ActionIntent, LiabilityContext, MandateBinding } from "@pharos/core";

/**
 * The judge panel contract (Workstream D, handoff 2026-10-29).
 *
 * Tier 3 is a panel of typed judges under one contract. The deterministic policy layer still
 * selects the decision; a judge emits a signal (score, confidence, citation), never a verdict.
 * The content models that exist today (`JudgeResult` from `./model.ts` — probability, flag,
 * threshold) keep their result type because fixtures, the drift monitor, and the eval harness
 * consume it; the panel wraps them. This file names the panel result `PanelJudgeResult` for
 * that reason.
 */
export type JudgeKind =
  "structural" | "content" | "adversarial" | "intent" | "simulation" | "consensus";

/** Per-tenant facts a judge may consult. Everything is optional: an absent fact makes the checks that need it abstain. */
export interface TenantContext {
  tenantId: string;
  /** JSON-schema subset per action type (`type`, `required`, `properties`, `enum`, `minimum`, `maximum`). */
  actionSchemas?: Record<string, ActionSchema>;
  /** The allowed next tool calls for the agent's current plan, derived by the caller from the causal evidence graph. */
  plan?: { allowedNext: string[]; source?: string };
}

export interface ActionSchema {
  type?: "object";
  required?: string[];
  properties?: Record<string, PropertySchema>;
  additionalProperties?: boolean;
}

export interface PropertySchema {
  type?: "string" | "number" | "integer" | "boolean" | "object" | "array";
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

export interface JudgeInput {
  action: ActionIntent;
  liability: LiabilityContext;
  context: TenantContext;
  /** The mandate the action runs under (server-resolved or, later, from a MandateToken). */
  mandate: MandateBinding | null;
  /** Raw action text plus the cascade's normalized variants (ADR 0004); content judges score each. */
  textVariants: string[];
  /** Signals from judges that ran earlier in the panel (empty in D1: all judges run concurrently). */
  priorSignals: PanelJudgeResult[];
}

export interface PanelJudgeResult {
  kind: JudgeKind;
  /** Stable concern id, e.g. `finra-promissory` or `structural.blast-radius`. */
  concern: string;
  /** Severity in [0,1]; content judges report their calibrated probability. */
  score: number;
  /** How sure the judge is of its own score, in [0,1]. Deterministic checks report 1. */
  confidence: number;
  /** True when the judge had nothing to say (check not applicable, fact missing). */
  abstain: boolean;
  /** Rule id the signal cites, when the judge has one. */
  citation?: string;
  rationale?: string;
  /** Content-hashed identity: `<artifact-hash>` [+ `:<runtime identity>`] [+ `:<prompt hash>`]. */
  judgeVersion: string;
  judgeRuntime?: string;
  latencyMs: number;
  /** Shadow judges are evaluated and sealed but never influence the decision (D2). */
  shadow: boolean;
  /** For content judges: the frozen threshold their `flagged` was computed at. */
  threshold?: number;
}

/** A monotonic budget the panel hands each judge. */
export interface Deadline {
  readonly deadlineMs: number;
  remainingMs(): number;
  expired(): boolean;
}

export function deadlineFrom(startNs: bigint, deadlineMs: number): Deadline {
  return {
    deadlineMs,
    remainingMs: () => deadlineMs - Number(process.hrtime.bigint() - startNs) / 1e6,
    expired() {
      return this.remainingMs() <= 0;
    },
  };
}

export interface Judge {
  readonly kind: JudgeKind;
  /** Stable identifier used in `verdict.latency.perTier` keys (`3/<id>`) and shadow reports. */
  readonly id: string;
  /** Routing: only judges whose concern applies to this action type run. */
  appliesTo(action: ActionIntent): boolean;
  evaluate(input: JudgeInput, deadline: Deadline): Promise<PanelJudgeResult>;
}

/** Prefix match on `action.type` — the routing primitive shared by bindings and judges. */
export function actionTypeMatches(actionType: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => (p.endsWith(".") ? actionType.startsWith(p) : actionType === p));
}
