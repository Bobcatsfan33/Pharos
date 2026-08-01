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
  type JudgePackBinding,
} from "./cascade.js";
// NOTE: ./testing.js (fault injection) is deliberately NOT exported here — see #82.
// It is reachable only by an explicit deep import from tests.

import type { JudgePackBinding } from "./cascade.js";

/** Default Tier-3 pack bindings (FINRA + HIPAA + funds movement). */
export const DEFAULT_PACK_BINDINGS: JudgePackBinding[] = [
  {
    packId: "finra-promissory",
    onFlag: "block",
    citation: {
      ruleId: "finra-2210-promissory",
      pack: "finra",
      clause: "FINRA Rule 2210(d)(1)(B)",
    },
  },
  {
    packId: "phi-in-context",
    onFlag: "escalate",
    citation: {
      ruleId: "hipaa-phi-exposure",
      pack: "hipaa",
      clause: "45 CFR 164.502(b) minimum necessary",
    },
  },
  {
    packId: "funds-movement-intent",
    onFlag: "escalate",
    requireNoMandate: true,
    citation: { ruleId: "funds-movement-unmandated", pack: "core", clause: "mandate.required" },
  },
];
