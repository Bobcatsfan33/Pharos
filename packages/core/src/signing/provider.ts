/**
 * Signing provider abstraction.
 *
 * Records are signed with KMS-backed keys. The private key never leaves the
 * provider; callers only ever request signatures and read public keys. This lets
 * us swap the local simulated KMS (dev/test) for AWS KMS (prod) by configuration,
 * and it is what makes external verification possible: the published public keyset
 * is sufficient to validate any record without trusting Pharos.
 *
 * A keyId encodes both the logical key name and its version: `<name>#<version>`.
 * Rotation mints a new version while old versions remain valid for verification,
 * giving chain continuity across rotations (each record embeds the keyId that
 * signed it).
 */
export interface PublicKeyEntry {
  keyId: string;
  /** Base64 DER (SPKI) Ed25519 public key. */
  publicKey: string;
  algorithm: "ed25519";
}

export interface SigningProvider {
  readonly providerId: string;

  /** Ensure a signing key exists for `keyName`; returns the active keyId. Idempotent. */
  ensureKey(keyName: string): Promise<string>;

  /** Mint a new version for `keyName` and make it active; returns the new keyId. */
  rotate(keyName: string): Promise<string>;

  /** The currently active keyId for `keyName`. */
  activeKeyId(keyName: string): Promise<string>;

  /** Sign `message` with `keyId`; returns base64 signature. */
  sign(keyId: string, message: Buffer): Promise<string>;

  /** Verify a base64 `signature` over `message` for `keyId`. */
  verify(keyId: string, message: Buffer, signature: string): Promise<boolean>;

  /** Public key for a single keyId (for external verification bundles). */
  getPublicKey(keyId: string): Promise<PublicKeyEntry | null>;

  /** All public keys ever minted (the published keyset). */
  publishKeyset(): Promise<PublicKeyEntry[]>;
}

export function makeKeyId(keyName: string, version: number): string {
  return `${keyName}#v${version}`;
}

export function parseKeyId(keyId: string): { keyName: string; version: number } {
  const idx = keyId.lastIndexOf("#v");
  if (idx < 0) throw new Error(`Malformed keyId: ${keyId}`);
  const keyName = keyId.slice(0, idx);
  const version = Number(keyId.slice(idx + 2));
  if (!keyName || !Number.isInteger(version)) throw new Error(`Malformed keyId: ${keyId}`);
  return { keyName, version };
}

/** Bytes signed for a LEGACY (v1) record seal: the ASCII of its 64-char hex contentHash. */
export function signingMessage(contentHash: string): Buffer {
  return Buffer.from(contentHash, "utf8");
}

/**
 * Seal signature v2 — the signature covers the chain position, not just the
 * content. v1 signed only contentHash, so a signed record could be spliced
 * into a different chain position (or another tenant's chain) and its
 * prevHash rewritten without invalidating the signature; only the unsigned
 * chain-link check would notice. v2 signs a domain-separated message binding
 * {sequence, prevHash, contentHash}.
 */
export const SEAL_SIGNATURE_VERSION = 2 as const;

export function signingMessageV2(params: {
  contentHash: string;
  prevHash: string;
  sequence: number;
}): Buffer {
  return Buffer.from(
    `pharos:record-seal:v2\n${params.sequence}\n${params.prevHash}\n${params.contentHash}`,
    "utf8",
  );
}

/** The bytes a seal's signature must verify against, dispatching on its sigVersion. */
export function sealSigningMessage(
  seal: { contentHash: string; prevHash: string; sigVersion?: number },
  sequence: number,
): Buffer {
  if ((seal.sigVersion ?? 1) >= 2) {
    return signingMessageV2({ contentHash: seal.contentHash, prevHash: seal.prevHash, sequence });
  }
  return signingMessage(seal.contentHash);
}
