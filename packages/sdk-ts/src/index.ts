export { PharosClient, type PharosClientOptions } from "./client.js";
// Exported so callers can validate a submission ahead of time (e.g. when building one
// incrementally) using exactly the check `submit()` applies.
export { validateSubmitInput } from "./validate.js";
export * from "./types.js";
// MandateToken (Workstream A): offline verification and holder-side attenuation.
export {
  verifyMandateToken,
  attenuateMandateToken,
  effectiveAuthority,
  scopeAllowsActionType,
  mandateTokenBlockHashes,
  mandateTokenHeadHash,
  canonicalJson,
  MANDATE_TOKEN_MAX_BLOCKS,
  type MandateAuthority,
  type AttenuationBlock,
  type AttenuationCheck,
  type EffectiveAuthority,
  type MandateLimits,
  type MandateScope,
  type MandateTokenVerifyCode,
  type MandateTokenVerifyResult,
  type TokenProof,
  type VerifyMandateTokenOptions,
} from "./mandateToken.js";
