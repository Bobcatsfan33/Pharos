export {
  type Condition,
  type FieldCondition,
  type JudgeCondition,
  type PolicyRule,
  type PolicyArtifact,
  type EvalContext,
  type RuleMatch,
  evalCondition,
  evaluateArtifact,
} from "./rules.js";
export { type CompileResult, compilePolicy } from "./compiler.js";
export {
  type VerdictMix,
  type DryRunResult,
  type DivergenceResult,
  decideWith,
  dryRun,
  divergence,
} from "./simulate.js";
export {
  importPolicy,
  importOpaPolicy,
  importCedarPolicy,
  importPharosPolicy,
  canonicalPolicyIr,
  signPolicyBundle,
  verifyPolicyBundle,
  type PortableCondition,
  type OpaPolicyDocument,
  type CedarPolicyDocument,
  type PolicySourceDocument,
  type PolicyImportResult,
  type SignedPolicyBundle,
} from "./interop.js";

import { FINRA_PACK_V2 } from "./packs/finra-v2.js";
import { HIPAA_PACK_V2 } from "./packs/hipaa-v2.js";
import { CODING_AGENT_SAFETY_PACK } from "./packs/coding-agent-safety.js";
import type { PolicyArtifact } from "./rules.js";

/**
 * The shipped, versioned packs. Every tenant is evaluated against all of them; each pack's
 * rules only match the action shapes it governs (payments/communications, PHI, and — for
 * coding-agent-safety — shell.exec / file.* / git.* actions), so adding a pack never changes
 * verdicts for action types it does not name.
 */
export const SHIPPED_PACKS: Record<string, PolicyArtifact> = {
  finra: FINRA_PACK_V2,
  hipaa: HIPAA_PACK_V2,
  "coding-agent-safety": CODING_AGENT_SAFETY_PACK,
};
export { FINRA_PACK_V2, HIPAA_PACK_V2, CODING_AGENT_SAFETY_PACK };
