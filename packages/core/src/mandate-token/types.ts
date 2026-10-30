import type { PublicKeyEntry } from "../signing/provider.js";

/**
 * MandateToken — portable, attenuable authority (Workstream A).
 *
 * A token is an authority block signed by the tenant's mandate key plus zero or more
 * attenuation blocks, each signed by the ephemeral key the previous block published and
 * each only able to NARROW what came before. Verification is a pure function of the token,
 * the tenant's published public key, and a clock: no database, no network. The
 * construction follows the Biscuit specification (authority + attenuation chain + proof);
 * the checks are Pharos rule-citation JSON, not Datalog.
 */

export type ReversibilityLimit = "reversible" | "irreversible" | "any";

export interface MandateScope {
  /** Action-type patterns: `"*"` any; `"email."` every type under that prefix; else exact. */
  actionTypes: string[];
  /** Resource patterns: `"*"` any; a trailing `*` is a prefix; else exact. */
  resources: string[];
}

export interface MandateLimits {
  /** Monetary ceiling; absent = no ceiling stated. */
  financialAmount?: number;
  currency?: string;
  reversibility?: ReversibilityLimit;
}

export interface MandateAuthority {
  tenantId: string;
  agentId: string;
  /** The stored mandate this token was minted from. */
  mandateId: string;
  grantor: string;
  issuedAt: string;
  expiresAt: string;
  scope: MandateScope;
  limits: MandateLimits;
  /** Rule ids this mandate was granted under. */
  citations: string[];
  /** The tenant mandate key (`mandate:<tenantId>#vN`) whose published entry verifies block 0. */
  keyId: string;
  /** Base64 raw Ed25519 public key that must sign block 1. */
  nextKey: string;
}

export type AttenuationCheck =
  | { kind: "limit"; value: MandateLimits }
  | { kind: "expiry"; value: string }
  | { kind: "scope"; value: Partial<MandateScope> };

export interface AttenuationBlock {
  checks: AttenuationCheck[];
  issuedAt: string;
  /** Base64 raw Ed25519 public key that must sign the next block. */
  nextKey: string;
}

/**
 * What makes the chain complete. `next` carries the current ephemeral private key (the token
 * can be attenuated further); `sealed` is a final signature by that key (it cannot). Without
 * a proof a verifier could not distinguish a truncated chain — blocks dropped, scope widened —
 * from a shorter honest one.
 */
export type TokenProof = { kind: "next"; secret: string } | { kind: "sealed"; signature: string };

export interface MandateToken {
  v: 1;
  authority: MandateAuthority;
  blocks: AttenuationBlock[];
  /** One base64 signature per authority/block: `signatures[0]` over the authority. */
  signatures: string[];
  proof: TokenProof;
}

/** The authority that is actually in force after every block has narrowed it. */
export type EffectiveAuthority = Omit<MandateAuthority, "nextKey" | "keyId">;

export type VerifyErrorCode =
  | "malformed"
  | "too-many-blocks"
  | "root-key-mismatch"
  | "root-signature"
  | "block-signature"
  | "key-reuse"
  | "widening"
  | "proof"
  | "expired"
  | "tenant-mismatch"
  | "agent-mismatch";

export interface VerifyResult {
  ok: boolean;
  code: VerifyErrorCode | null;
  errors: string[];
  effective: EffectiveAuthority | null;
  /** `[sha256(authority), sha256(block 0), …]` — what the ActionRecord seals. */
  blockHashes: string[];
  /** sha256 over the token minus its proof. */
  headHash: string;
}

export interface VerifyOptions {
  /** Refuse a token minted for another tenant / agent. */
  expect?: { tenantId?: string; agentId?: string };
  /** Chain-length ceiling; default MAX_BLOCKS. */
  maxBlocks?: number;
}

/** Either the published keyset entry (any algorithm) or a raw 32-byte Ed25519 public key. */
export type RootKey = PublicKeyEntry | Uint8Array;

/** What the ActionRecord carries about a presented token (liability.mandateToken). */
export interface SealedMandateToken {
  rootKeyId: string;
  blockHashes: string[];
  headHash: string;
  /** `"verified"`, or the structural reason the token was refused. */
  verification: "verified" | VerifyErrorCode | "root-key-unknown" | "mandate-revoked";
  /** The authority in force when verified; absent when refused. */
  effective?: EffectiveAuthority;
}
