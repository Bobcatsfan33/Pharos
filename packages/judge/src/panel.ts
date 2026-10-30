import type { ActionIntent } from "@pharos/core";
import {
  type Deadline,
  type Judge,
  type JudgeInput,
  type PanelJudgeResult,
  actionTypeMatches,
} from "./contract.js";
import type { JudgeResult } from "./model.js";
import type { ModelRegistry } from "./registry.js";

/**
 * Wrap one content-model pack from the registry as a panel judge. Routing: the pack declares the
 * action-type prefixes its concern is about (a FINRA communications model has nothing to say
 * about `crm.update`); with no declaration the model applies to everything (`routing: "all"`).
 */
export class ContentModelJudge implements Judge {
  readonly kind = "content" as const;
  constructor(
    private readonly registry: ModelRegistry,
    readonly id: string,
    private readonly actionTypes: readonly string[] | undefined,
    private readonly routing: "strict" | "all",
  ) {}

  appliesTo(action: ActionIntent): boolean {
    if (this.routing === "all" || !this.actionTypes) return true;
    return actionTypeMatches(action.type, this.actionTypes);
  }

  /** The content model result the cascade's policy rules and the drift monitor consume. */
  async score(input: JudgeInput): Promise<JudgeResult> {
    let worst: JudgeResult | null = null;
    // Score the raw text and every normalized variant; take the MORE-SEVERE result (ADR 0004).
    for (const text of input.textVariants) {
      const r = await this.registry.judgeAsync(this.id, text);
      if (!worst || r.probability > worst.probability) worst = r;
    }
    return worst!;
  }

  async evaluate(input: JudgeInput, _deadline: Deadline): Promise<PanelJudgeResult> {
    void _deadline;
    const start = process.hrtime.bigint();
    const r = await this.score(input);
    return toPanelResult(r, Number(process.hrtime.bigint() - start) / 1e6);
  }
}

export function toPanelResult(r: JudgeResult, latencyMs: number): PanelJudgeResult {
  return {
    kind: "content",
    concern: r.packId,
    score: r.probability,
    confidence: Math.abs(r.probability - r.threshold) * 2,
    abstain: false,
    judgeVersion: r.judgeVersion,
    ...(r.judgeRuntime ? { judgeRuntime: r.judgeRuntime } : {}),
    latencyMs,
    shadow: false,
    threshold: r.threshold,
  };
}

export interface PanelRun {
  /** Results in judge order (deterministic evidence), one per judge that applied. */
  results: PanelJudgeResult[];
  /** `3/<judgeId>` → milliseconds, for `verdict.latency.perTier`. */
  perJudgeMs: Record<string, number>;
  /** Ids of judges that were routed out (did not apply). */
  skipped: string[];
}

/**
 * The panel: routes, then runs every applicable judge CONCURRENTLY under the cascade's
 * deadline, recording per-judge latency. Wall time is max(judge) + scheduling, not sum.
 */
export class JudgePanel {
  constructor(readonly judges: readonly Judge[]) {}

  applicable(action: ActionIntent): Judge[] {
    return this.judges.filter((j) => j.appliesTo(action));
  }

  async run(input: JudgeInput, deadline: Deadline): Promise<PanelRun> {
    const applicable = this.applicable(input.action);
    const skipped = this.judges.filter((j) => !applicable.includes(j)).map((j) => j.id);
    const results = await Promise.all(applicable.map((j) => j.evaluate(input, deadline)));
    const perJudgeMs: Record<string, number> = {};
    applicable.forEach((j, i) => {
      perJudgeMs[`3/${j.id}`] = results[i]!.latencyMs;
    });
    return { results, perJudgeMs, skipped };
  }
}
