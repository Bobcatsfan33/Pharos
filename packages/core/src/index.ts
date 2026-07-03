// Schema
export * from "./schema/version.js";
export * from "./schema/actionRecord.js";

// Canonicalization & hashing
export { canonicalize, sha256Hex } from "./chain/canonical.js";

// Sealing & verification
export { sealRecord } from "./chain/seal.js";
export {
  verifyRecord,
  verifyChain,
  keysetVerifier,
  type RecordVerification,
  type ChainVerification,
} from "./chain/verify.js";

// Signing / KMS
export {
  type SigningProvider,
  type PublicKeyEntry,
  makeKeyId,
  parseKeyId,
  signingMessage,
  signingMessageV2,
  sealSigningMessage,
  SEAL_SIGNATURE_VERSION,
} from "./signing/provider.js";
export { type KeystoreBackend, type StoredKey, FileKeystore } from "./signing/keystore.js";
export { LocalKms } from "./signing/localKms.js";

// Verdict engine
export {
  VerdictEngine,
  type VerdictRequest,
  type VerdictEngineOptions,
} from "./verdict/engine.js";

// Selective-disclosure redaction
export {
  type DisclosureSet,
  type RedactedView,
  type RedactedField,
  type RedactionVerification,
  computeDisclosures,
  disclosureRoot,
  disclosureBindingMessage,
  redactPayload,
  verifyRedactedView,
} from "./redaction.js";

// Migration
export {
  LighthouseVerdictSchema,
  type LighthouseVerdict,
  FlightlineEventSchema,
  type FlightlineEvent,
} from "./migration/legacy.js";
export {
  fromLighthouseVerdict,
  fromFlightlineEvent,
  toLighthouseVerdict,
  toFlightlineEvent,
} from "./migration/adapters.js";
