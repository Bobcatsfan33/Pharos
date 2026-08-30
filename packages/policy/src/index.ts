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
import type { PolicyArtifact } from "./rules.js";

/** The shipped, versioned regulation packs. */
export const SHIPPED_PACKS: Record<string, PolicyArtifact> = {
  finra: FINRA_PACK_V2,
  hipaa: HIPAA_PACK_V2,
};
export { FINRA_PACK_V2, HIPAA_PACK_V2 };
