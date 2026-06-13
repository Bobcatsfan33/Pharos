import {
  type VerdictContext,
  type VerdictDecision,
  type VerdictRequest,
  type RuleCitation,
  VerdictEngine,
} from "@pharos/core";
import { type ModelRegistry, type JudgeResult } from "@pharos/judge";
import { scoreRisk } from "./riskScorer.js";
import { DeadlineExceeded, withDeadline } from "./deadline.js";

/**
 * The tiered decision cascade — the central technical claim of Pharos.
 *
 *   Tier 1  deterministic rules (mandate limits, expiry, deny lists)  — short-circuits on block
 *   Tier 2  statistical risk scoring                                   — short-circuits on extreme risk
 *   Tier 3  served distilled judge models                             — semantic evaluation
 *
 * Each tier is instrumented for latency. The whole cascade runs under a hard deadline; on
 * timeout or fault it returns an engineered fail-open / fail-closed verdict. Given the same
 * policy, judge versions, and inputs, the cascade is deterministic and replayable.
 */
const SEVERITY: Record<VerdictDecision, number> = { allow: 0, modify: 1, escalate: 2, block: 3 };

const HIGH_RISK_SHORT_CIRCUIT = 0.9;

export interface JudgePackBinding {
  packId: string;
  /** What to do when this pack flags. */
  onFlag: "block" | "escalate";
  /** Only escalate/block when the action is unmandated (e.g. funds movement). */
  requireNoMandate?: boolean;
  citation: Omit<RuleCitation, "description">;
}

export interface CascadeFaults {
  judgeThrows?: boolean;
  judgeDelayMs?: number;
}

export interface CascadeDeps {
  engine: VerdictEngine;
  registry: ModelRegistry;
  deadlineMs: number;
  packs: JudgePackBinding[];
  /** Test hook: inject Tier-3 faults (failure / slowness) to exercise fail modes. */
  faults?: CascadeFaults;
}

export class VerdictCascade {
  constructor(private readonly deps: CascadeDeps) {}

  async evaluate(req: VerdictRequest, now: Date): Promise<VerdictContext> {
    const perTier: Record<string, number> = {};
    try {
      return await withDeadline(this.deps.deadlineMs, this.run(req, now, perTier));
    } catch (err) {
      if (err instanceof DeadlineExceeded || isJudgeFault(err)) {
        return this.failMode(req, perTier, err as Error);
      }
      throw err;
    }
  }

  private async run(req: VerdictRequest, now: Date, perTier: Record<string, number>): Promise<VerdictContext> {
    const citations: RuleCitation[] = [];
    let decision: VerdictDecision = "allow";
    let riskScore = 0;
    let tierReached: VerdictContext["tierReached"] = 1;
    let judgeVersion: string | null = null;

    // --- Tier 1: deterministic rules ---
    const t1Start = process.hrtime.bigint();
    const t1 = this.deps.engine.evaluate(req, now);
    perTier["1"] = elapsedMs(t1Start);
    citations.push(...t1.ruleCitations);
    decision = mostSevere(decision, t1.decision);
    riskScore = Math.max(riskScore, t1.riskScore);
    if (t1.decision === "block") {
      // Short-circuit: a deterministic block skips later tiers.
      return this.compose(decision, 1, citations, riskScore, null, perTier);
    }

    // --- Tier 2: statistical risk ---
    const t2Start = process.hrtime.bigint();
    const risk = scoreRisk(req);
    perTier["2"] = elapsedMs(t2Start);
    riskScore = Math.max(riskScore, risk.score);
    tierReached = 2;
    if (risk.score >= HIGH_RISK_SHORT_CIRCUIT) {
      decision = mostSevere(decision, "escalate");
      citations.push({
        ruleId: "risk-extreme",
        pack: "risk",
        clause: "tier2.score",
        description: `Statistical risk score ${risk.score.toFixed(2)} exceeded the escalation threshold; escalated without semantic evaluation.`,
      });
      return this.compose(decision, 2, citations, riskScore, null, perTier);
    }

    // --- Tier 3: served distilled judge models (semantic evaluation) ---
    const t3Start = process.hrtime.bigint();
    const judgeResults = await this.runJudges(req);
    perTier["3"] = elapsedMs(t3Start);
    tierReached = 3;

    // Default citation: the most salient judge (highest probability), even if not flagged.
    let topProb = -1;
    for (const r of judgeResults) {
      if (r.probability > topProb) {
        topProb = r.probability;
        judgeVersion = r.judgeVersion;
      }
    }
    // Cite the judge that DROVE the decision (most severe onFlag, tiebreak by probability).
    let decidingSeverity = -1;
    let decidingProb = -1;
    for (const binding of this.deps.packs) {
      const result = judgeResults.find((r) => r.packId === binding.packId);
      if (!result || !result.flagged) continue;
      if (binding.requireNoMandate && req.liability.mandate !== null) continue;
      decision = mostSevere(decision, binding.onFlag);
      riskScore = Math.max(riskScore, result.probability);
      citations.push({
        ...binding.citation,
        description: `Tier-3 judge ${result.judgeVersion} flagged "${result.concern}" (p=${result.probability.toFixed(2)}).`,
      });
      const sev = SEVERITY[binding.onFlag];
      if (sev > decidingSeverity || (sev === decidingSeverity && result.probability > decidingProb)) {
        decidingSeverity = sev;
        decidingProb = result.probability;
        judgeVersion = result.judgeVersion;
      }
    }

    return this.compose(decision, tierReached, citations, riskScore, judgeVersion, perTier);
  }

  private async runJudges(req: VerdictRequest): Promise<JudgeResult[]> {
    if (this.deps.faults?.judgeThrows) throw new JudgeFault("injected judge failure");
    if (this.deps.faults?.judgeDelayMs) await sleep(this.deps.faults.judgeDelayMs);
    const text = actionText(req);
    const results: JudgeResult[] = [];
    for (const binding of this.deps.packs) {
      if (!this.deps.registry.has(binding.packId)) continue;
      results.push(this.deps.registry.judge(binding.packId, text));
    }
    return results;
  }

  private compose(
    decision: VerdictDecision,
    tierReached: VerdictContext["tierReached"],
    citations: RuleCitation[],
    riskScore: number,
    judgeVersion: string | null,
    perTier: Record<string, number>,
  ): VerdictContext {
    const totalMs = Object.values(perTier).reduce((a, b) => a + b, 0);
    return {
      decision,
      tierReached,
      ruleCitations: citations,
      riskScore: Math.max(0, Math.min(1, riskScore)),
      failMode: null,
      judgeVersion,
      latency: { totalMs, perTier, deadlineMs: this.deps.deadlineMs, deadlineBreached: totalMs > this.deps.deadlineMs },
    };
  }

  /**
   * Engineered fail mode. Reversible actions fail open (allow + async review); irreversible
   * actions fail closed (escalate to a human). The reason is sealed into the record.
   */
  private failMode(req: VerdictRequest, perTier: Record<string, number>, err: Error): VerdictContext {
    const reversible = req.liability.blastRadius.reversibility === "reversible";
    const failMode = reversible ? "fail_open" : "fail_closed";
    const decision: VerdictDecision = reversible ? "allow" : "escalate";
    const totalMs = Object.values(perTier).reduce((a, b) => a + b, 0);
    return {
      decision,
      tierReached: perTier["3"] !== undefined ? 3 : perTier["2"] !== undefined ? 2 : 1,
      ruleCitations: [
        {
          ruleId: failMode === "fail_open" ? "deadline-fail-open" : "deadline-fail-closed",
          pack: "core",
          clause: "deadline",
          description:
            `Cascade did not complete within budget (${err.message}). ` +
            (reversible
              ? "Reversible action failed open and was queued for async review."
              : "Irreversible action failed closed and was escalated for human confirmation."),
        },
      ],
      riskScore: 0.5,
      failMode,
      judgeVersion: null,
      latency: { totalMs, perTier, deadlineMs: this.deps.deadlineMs, deadlineBreached: true },
    };
  }
}

class JudgeFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeFault";
  }
}
function isJudgeFault(err: unknown): boolean {
  return err instanceof JudgeFault;
}

function mostSevere(a: VerdictDecision, b: VerdictDecision): VerdictDecision {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Extract a text representation of the action for semantic evaluation. */
export function actionText(req: VerdictRequest): string {
  const parts: string[] = [req.action.type];
  collectStrings(req.action.payload, parts);
  return parts.join(" ");
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 5) return;
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
}
