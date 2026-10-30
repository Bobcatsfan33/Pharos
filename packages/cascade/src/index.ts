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
// NOTE: ./testing.js (fault injection) is deliberately NOT exported here — see #82.
// It is reachable only by an explicit deep import from tests.

import type { JudgePackBinding } from "./cascade.js";

/** Action types that carry outbound communications — the FINRA and PHI models' domain. */
export const COMMUNICATION_ACTION_TYPES = [
  "email.",
  "message.",
  "chat.",
  "sms.",
  "comms.",
  "communication.",
  "post.",
  "document.",
  "marketing.",
  "notification.",
];
/** Action types that can expose records: communications plus exports and record operations. */
export const DISCLOSURE_ACTION_TYPES = [
  ...COMMUNICATION_ACTION_TYPES,
  "export",
  "data.",
  "record.",
  "file.",
  "notes.",
  "report.",
];
/** Action types that move money. */
export const FUNDS_ACTION_TYPES = [
  "payment.",
  "wire.",
  "funds.",
  "transfer.",
  "treasury.",
  "invoice.",
  "payout.",
  "refund.",
];

/**
 * Default Tier-3 pack bindings (FINRA + HIPAA + funds movement), each routed to the action
 * types its concern is about (D1): no communications model runs on `crm.update`.
 */
export const DEFAULT_PACK_BINDINGS: JudgePackBinding[] = [
  {
    packId: "finra-promissory",
    actionTypes: COMMUNICATION_ACTION_TYPES,
    onFlag: "block",
    citation: {
      ruleId: "finra-2210-promissory",
      pack: "finra",
      clause: "FINRA Rule 2210(d)(1)(B)",
    },
  },
  {
    packId: "phi-in-context",
    actionTypes: DISCLOSURE_ACTION_TYPES,
    onFlag: "escalate",
    citation: {
      ruleId: "hipaa-phi-exposure",
      pack: "hipaa",
      clause: "45 CFR 164.502(b) minimum necessary",
    },
  },
  {
    packId: "funds-movement-intent",
    actionTypes: FUNDS_ACTION_TYPES,
    onFlag: "escalate",
    requireNoMandate: true,
    citation: { ruleId: "funds-movement-unmandated", pack: "core", clause: "mandate.required" },
  },
];
