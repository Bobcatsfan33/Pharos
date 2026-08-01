import type { JudgeResult } from "@pharos/judge";
import type { VerdictRequest } from "@pharos/core";
import { VerdictCascade, JudgeFault, type CascadeDeps } from "./cascade.js";

/**
 * Test-only fault injection for the decision cascade (#82).
 *
 * The production `VerdictCascade` previously accepted a `faults` dependency, so the
 * shipped class contained a branch into injected failure. It was only reachable via a
 * field the server never set — but "never set" is an operational claim about call
 * sites, not a structural one about the code. Moving the seam into a subclass makes it
 * structural: `VerdictCascade` has no fault path at all, whatever it is constructed
 * with.
 *
 * This module is deliberately NOT re-exported from the package index, so it does not
 * appear on `@pharos/cascade`'s public surface and cannot be reached by an ordinary
 * import of the package.
 *
 * Faults are raised through the same `JudgeFault` the fail-mode path already handles,
 * so tests exercise the real production error route rather than a parallel one.
 */
export interface CascadeFaults {
  /** Raise a Tier-3 judge failure. */
  judgeThrows?: boolean;
  /** Stall Tier-3 to drive the deadline / fail-mode path. */
  judgeDelayMs?: number;
}

export class FaultInjectingCascade extends VerdictCascade {
  constructor(
    deps: CascadeDeps,
    private readonly faults: CascadeFaults = {},
  ) {
    super(deps);
  }

  protected override async runJudges(req: VerdictRequest): Promise<JudgeResult[]> {
    if (this.faults.judgeThrows) throw new JudgeFault("injected judge failure");
    if (this.faults.judgeDelayMs) await sleep(this.faults.judgeDelayMs);
    return super.runJudges(req);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
