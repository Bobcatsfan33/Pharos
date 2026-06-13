import type { VerdictDecision } from "@pharos/core";
import { type PolicyArtifact, type EvalContext, evaluateArtifact } from "./rules.js";

/**
 * Dry-run simulation, impact analysis, and shadow-mode divergence.
 *
 * A compiled or edited policy is dry-run against a historical traffic window BEFORE it can be
 * activated, producing the predicted verdict mix (the impact dashboard). In shadow mode the
 * candidate's decisions are computed but not enforced, and compared against the active
 * policy's decisions to report divergence.
 */
const SEVERITY: Record<VerdictDecision, number> = { allow: 0, modify: 1, escalate: 2, block: 3 };

export function decideWith(artifact: PolicyArtifact, ctx: EvalContext): VerdictDecision {
  const matches = evaluateArtifact(artifact, ctx);
  let decision: VerdictDecision = "allow";
  for (const m of matches) if (SEVERITY[m.decision] > SEVERITY[decision]) decision = m.decision;
  return decision;
}

export interface VerdictMix {
  allow: number;
  block: number;
  modify: number;
  escalate: number;
}

export interface DryRunResult {
  total: number;
  mix: VerdictMix;
  byRule: Record<string, number>;
}

export function dryRun(artifact: PolicyArtifact, contexts: EvalContext[]): DryRunResult {
  const mix: VerdictMix = { allow: 0, block: 0, modify: 0, escalate: 0 };
  const byRule: Record<string, number> = {};
  for (const ctx of contexts) {
    const matches = evaluateArtifact(artifact, ctx);
    for (const m of matches) byRule[m.citation.ruleId] = (byRule[m.citation.ruleId] ?? 0) + 1;
    mix[decideWith(artifact, ctx)] += 1;
  }
  return { total: contexts.length, mix, byRule };
}

export interface DivergenceResult {
  total: number;
  diverged: number;
  changes: Array<{ from: VerdictDecision; to: VerdictDecision; count: number }>;
}

/** Compare a candidate (shadow) policy's decisions against the active policy's decisions. */
export function divergence(active: PolicyArtifact, candidate: PolicyArtifact, contexts: EvalContext[]): DivergenceResult {
  const changeCounts = new Map<string, number>();
  let diverged = 0;
  for (const ctx of contexts) {
    const a = decideWith(active, ctx);
    const c = decideWith(candidate, ctx);
    if (a !== c) {
      diverged += 1;
      const key = `${a}->${c}`;
      changeCounts.set(key, (changeCounts.get(key) ?? 0) + 1);
    }
  }
  const changes = [...changeCounts.entries()].map(([k, count]) => {
    const [from, to] = k.split("->") as [VerdictDecision, VerdictDecision];
    return { from, to, count };
  });
  return { total: contexts.length, diverged, changes };
}
