export { scoreRisk, type RiskBreakdown } from "./riskScorer.js";
export { DeadlineExceeded, withDeadline } from "./deadline.js";
export { fingerprintVerdict, verdictsIdentical } from "./reproduce.js";
export {
  canonicalize,
  decodeCandidates,
  normalizedVariants,
  NORMALIZER_VERSION,
} from "./normalize.js";
export {
  VerdictCascade,
  JudgeFault,
  actionText,
  type CascadeDeps,
  type ContentRun,
  type JudgePackBinding,
} from "./cascade.js";
// NOTE: ./testing.js (fault injection) is deliberately NOT exported here.
// It is reachable only by an explicit deep import from tests.

import { SHIPPED_PACKS, judgeBindingsOf } from "@pharos/policy";
import type { JudgePackBinding } from "./cascade.js";

/**
 * Default Tier-3 pack bindings: the judge bindings every shipped pack declares in
 * `packages/policy/packs/*.json`, each routed to the action types its concern is about, so
 * no communications model runs on `crm.update`. Adding a concern is adding a binding to a
 * pack file; nothing here changes.
 */
export const DEFAULT_PACK_BINDINGS: JudgePackBinding[] = judgeBindingsOf(SHIPPED_PACKS);
