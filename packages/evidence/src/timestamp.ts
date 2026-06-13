import { type SigningProvider, sha256Hex } from "@pharos/core";

/**
 * Trusted timestamps and external anchoring.
 *
 * Each chain head is timestamped and signed by an INDEPENDENT timestamp authority (a
 * separate signing key, standing in for an RFC 3161 TSA + an external transparency log).
 * Because the anchor is signed by a key Pharos does not control in production, tamper-
 * evidence does not require trusting Pharos: a verifier checks the anchor's signature with
 * the TSA's published public key.
 */
export interface TrustedTimestamp {
  /** What was timestamped (a chain head hash or a bundle hash). */
  hash: string;
  /** RFC-3339 time asserted by the authority. */
  time: string;
  keyId: string;
  signature: string;
}

function tokenMessage(hash: string, time: string): Buffer {
  return Buffer.from(sha256Hex({ hash, time }), "utf8");
}

export async function createTimestamp(
  tsa: SigningProvider,
  tsaKeyName: string,
  hash: string,
  time: string,
): Promise<TrustedTimestamp> {
  const keyId = await tsa.ensureKey(tsaKeyName);
  const signature = await tsa.sign(keyId, tokenMessage(hash, time));
  return { hash, time, keyId, signature };
}

/** Verify a timestamp offline given a signature-check function (TSA public key). */
export function verifyTimestamp(
  ts: TrustedTimestamp,
  verify: (keyId: string, message: Buffer, signature: string) => boolean,
): boolean {
  return verify(ts.keyId, tokenMessage(ts.hash, ts.time), ts.signature);
}
