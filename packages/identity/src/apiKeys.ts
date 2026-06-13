import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Scoped API keys for SDK / gateway ingestion.
 *
 * The plaintext key is shown once at creation and never stored; only a SHA-256 hash of
 * the secret is persisted. Keys carry explicit scopes (least privilege) and support
 * rotation: a new key can be minted and used while the old one is still valid, so
 * rotation never drops in-flight ingestion.
 *
 * Format: pk_<keyId>_<secret>
 *   keyId  — public identifier, safe to log and index
 *   secret — high-entropy, compared in constant time against the stored hash
 */
const PREFIX = "pk";

export interface GeneratedApiKey {
  keyId: string;
  secret: string;
  /** The full plaintext to hand to the caller exactly once. */
  plaintext: string;
  secretHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const keyId = randomBytes(8).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  return {
    keyId,
    secret,
    plaintext: `${PREFIX}_${keyId}_${secret}`,
    secretHash: hashSecret(secret),
  };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

export function parseApiKey(plaintext: string): ParsedApiKey | null {
  // The secret is base64url and may itself contain '_', so split on only the first two
  // separators: pk_<keyId>_<secret>. keyId is hex and never contains '_'.
  const first = plaintext.indexOf("_");
  if (first < 0 || plaintext.slice(0, first) !== PREFIX) return null;
  const second = plaintext.indexOf("_", first + 1);
  if (second < 0) return null;
  const keyId = plaintext.slice(first + 1, second);
  const secret = plaintext.slice(second + 1);
  if (!keyId || !secret) return null;
  return { keyId, secret };
}

/** Constant-time comparison of a presented secret against a stored hash. */
export function verifySecret(presentedSecret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(presentedSecret), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
