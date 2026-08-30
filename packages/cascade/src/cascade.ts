import {
  type VerdictContext,
  type VerdictDecision,
  type VerdictRequest,
  type RuleCitation,
  VerdictEngine,
} from "@pharos/core";
import { type ModelRegistry, type JudgeResult } from "@pharos/judge";
import { type PolicyArtifact, evaluateArtifact } from "@pharos/policy";
import { scoreRisk } from "./riskScorer.js";
import { DeadlineExceeded, withDeadline } from "./deadline.js";
import { normalizedVariants } from "./normalize.js";

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

export interface CascadeDeps {
  engine: VerdictEngine;
  registry: ModelRegistry;
  deadlineMs: number;
  packs: JudgePackBinding[];
  /**
   * Active, versioned policy artifacts (Sprint 6). When provided, Tier-3 decisions come from
   * data-driven citation-level rules instead of the built-in bindings; the bindings still
   * drive which judge models run (to produce the probabilities the rules test).
   */
  policyArtifacts?: PolicyArtifact[];
  /**
   * Privacy-safe model monitoring hook. Receives only bounded judge outputs after Tier 3; callers
   * must not attach prompts, payloads, tenant IDs, or identities to model metrics.
   */
  onJudgeResults?: (results: readonly JudgeResult[]) => void;
}

/**
 * The production decision cascade.
 *
 * This class carries **no fault-injection path** (#82). Exercising fail modes is done
 * by `FaultInjectingCascade` in `./testing.js`, which subclasses this one and overrides
 * the judge step. Keeping the seam out of the shipped class means there is no branch a
 * production instance could take into injected failure, however its dependencies are
 * constructed — a stronger guarantee than "the server never sets that field".
 */
export class VerdictCascade {
  constructor(protected readonly deps: CascadeDeps) {}

  async evaluate(
    req: VerdictRequest,
    now: Date,
    policyOverride?: PolicyArtifact[],
  ): Promise<VerdictContext> {
    const perTier: Record<string, number> = {};
    const wallStart = process.hrtime.bigint();
    const artifacts = policyOverride ?? this.deps.policyArtifacts;
    try {
      const verdict = await withDeadline(
        this.deps.deadlineMs,
        this.run(req, now, perTier, artifacts),
      );
      const wallMs = elapsedMs(wallStart);
      // Native inference can occupy the event loop long enough that the timer callback cannot run
      // at the nominal deadline. Re-check monotonic wall time after control returns so an expired
      // verdict is never released as a normal allow/block decision merely because its timer starved.
      if (wallMs > this.deps.deadlineMs || verdict.latency.deadlineBreached) {
        return this.failMode(req, perTier, new DeadlineExceeded(this.deps.deadlineMs), wallMs);
      }
      return verdict;
    } catch (err) {
      if (err instanceof DeadlineExceeded || isJudgeFault(err)) {
        return this.failMode(req, perTier, err as Error, elapsedMs(wallStart));
      }
      throw err;
    }
  }

  private async run(
    req: VerdictRequest,
    now: Date,
    perTier: Record<string, number>,
    policyArtifacts: PolicyArtifact[] | undefined,
  ): Promise<VerdictContext> {
    const citations: RuleCitation[] = [];
    let decision: VerdictDecision = "allow";
    let riskScore = 0;
    let judgeVersion: string | null = null;
    let judgeRuntime: string | null = null;

    // --- Tier 1: deterministic rules ---
    const t1Start = process.hrtime.bigint();
    const t1 = this.deps.engine.evaluate(req, now);
    perTier["1"] = elapsedMs(t1Start);
    citations.push(...t1.ruleCitations);
    decision = mostSevere(decision, t1.decision);
    riskScore = Math.max(riskScore, t1.riskScore);
    if (t1.decision === "block") {
      // Short-circuit: a deterministic block skips later tiers.
      return this.compose(decision, 1, citations, riskScore, null, null, perTier);
    }

    // --- Tier 2: statistical risk ---
    const t2Start = process.hrtime.bigint();
    const risk = scoreRisk(req);
    perTier["2"] = elapsedMs(t2Start);
    riskScore = Math.max(riskScore, risk.score);
    if (risk.score >= HIGH_RISK_SHORT_CIRCUIT) {
      decision = mostSevere(decision, "escalate");
      citations.push({
        ruleId: "risk-extreme",
        pack: "risk",
        clause: "tier2.score",
        description: `Statistical risk score ${risk.score.toFixed(2)} exceeded the escalation threshold; escalated without semantic evaluation.`,
      });
      return this.compose(decision, 2, citations, riskScore, null, null, perTier);
    }

    // --- Tier 3: served distilled judge models (semantic evaluation) ---
    const t3Start = process.hrtime.bigint();
    const judgeResults = await this.runJudges(req);
    perTier["3"] = elapsedMs(t3Start);
    this.deps.onJudgeResults?.(judgeResults);

    // Default citation: the most salient judge (highest probability), even if not flagged.
    let topProb = -1;
    for (const r of judgeResults) {
      if (r.probability > topProb) {
        topProb = r.probability;
        judgeVersion = r.judgeVersion;
        judgeRuntime = r.judgeRuntime ?? null;
      }
    }
    if (policyArtifacts && policyArtifacts.length > 0) {
      // Sprint 6: data-driven citation-level pack rules over judge probabilities + fields.
      const judgeProbabilities: Record<string, number> = {};
      for (const r of judgeResults) {
        riskScore = Math.max(riskScore, r.probability);
        judgeProbabilities[r.packId] = r.probability;
      }
      const evalCtx = { request: req, judgeProbabilities };
      for (const artifact of policyArtifacts) {
        for (const m of evaluateArtifact(artifact, evalCtx)) {
          decision = mostSevere(decision, m.decision);
          citations.push(m.citation);
        }
      }
    } else {
      // Built-in bindings (default cascade): cite the judge that drove the decision.
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
        if (
          sev > decidingSeverity ||
          (sev === decidingSeverity && result.probability > decidingProb)
        ) {
          decidingSeverity = sev;
          decidingProb = result.probability;
          judgeVersion = result.judgeVersion;
          judgeRuntime = result.judgeRuntime ?? null;
        }
      }
    }

    return this.compose(decision, 3, citations, riskScore, judgeVersion, judgeRuntime, perTier);
  }

  /** Protected so the test-only subclass in ./testing.js can wrap it; never faulted here. */
  protected async runJudges(req: VerdictRequest): Promise<JudgeResult[]> {
    const raw = actionText(req);
    // Cascade-owned normalization (ADR 0004): score the RAW text AND the normalized variants
    // (unicode-canonicalized + reversibly-decoded), and take the MORE-SEVERE verdict per pack.
    // Obfuscation can only ADD detections — it can never mask a plaintext signal. Models stay bare.
    const texts = [...new Set([raw, ...normalizedVariants(raw)])];
    const results = await Promise.all(
      this.deps.packs.map(async (binding) => {
        if (!this.deps.registry.has(binding.packId)) return null;
        let worst: JudgeResult | null = null;
        for (const t of texts) {
          // judgeAsync dispatches on kind: logistic (sync, resolved) or served ONNX (async).
          const r = await this.deps.registry.judgeAsync(binding.packId, t);
          if (!worst || r.probability > worst.probability) worst = r;
        }
        return worst;
      }),
    );
    // Promise.all preserves pack order, so evidence and tie-breaking remain deterministic while
    // independent concern models execute concurrently.
    return results.filter((result): result is JudgeResult => result !== null);
  }

  private compose(
    decision: VerdictDecision,
    tierReached: VerdictContext["tierReached"],
    citations: RuleCitation[],
    riskScore: number,
    judgeVersion: string | null,
    judgeRuntime: string | null,
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
      judgeRuntime,
      latency: {
        totalMs,
        perTier,
        deadlineMs: this.deps.deadlineMs,
        deadlineBreached: totalMs > this.deps.deadlineMs,
      },
    };
  }

  /**
   * Engineered fail mode. Reversible actions fail open (allow + async review); irreversible
   * actions fail closed (escalate to a human). The reason is sealed into the record.
   */
  private failMode(
    req: VerdictRequest,
    perTier: Record<string, number>,
    err: Error,
    wallMs?: number,
  ): VerdictContext {
    const reversible = req.liability.blastRadius.reversibility === "reversible";
    const failMode = reversible ? "fail_open" : "fail_closed";
    const decision: VerdictDecision = reversible ? "allow" : "escalate";
    const totalMs = Math.max(
      wallMs ?? 0,
      Object.values(perTier).reduce((a, b) => a + b, 0),
    );
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
      judgeRuntime: null,
      latency: { totalMs, perTier, deadlineMs: this.deps.deadlineMs, deadlineBreached: true },
    };
  }
}

/**
 * A Tier-3 judge failure, routed to the fail-mode path rather than propagating.
 *
 * Exported so the test-only subclass can raise it and exercise fail modes through
 * exactly the production code path; the production class itself never throws it.
 */
export class JudgeFault extends Error {
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
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
}
