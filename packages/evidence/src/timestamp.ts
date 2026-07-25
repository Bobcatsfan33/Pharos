import { type SigningProvider, sha256Hex } from "@pharos/core";
import { requestTimestamp, verifyRfc3161Token, type Rfc3161Options } from "./rfc3161.js";

/**
 * Trusted timestamps and external anchoring.
 *
 * A chain head is timestamped by an INDEPENDENT timestamp authority so tamper-evidence does not
 * require trusting Pharos. Two providers implement {@link TsaProvider}:
 *
 *   - `local`   — a simulated TSA: a separate signing key signs `sha256({hash, time})`, with the
 *                 time set by Pharos. Dependency-free and hermetic, used for dev/CI.
 *   - `rfc3161` — a real RFC 3161 TSA: Pharos sends only the hash; the TSA sets the time and
 *                 returns a signed DER token (see rfc3161.ts). The stored token is verifiable
 *                 offline against the TSA's own certificate — genuinely independent time.
 *
 * A `TrustedTimestamp` carries a `provider` discriminator; verification dispatches on it. Legacy
 * anchors (pre-Sprint-4) have no `provider` and are treated as `local`.
 */
export interface TrustedTimestamp {
  /** What was timestamped (a chain-head hash or a bundle hash). */
  hash: string;
  /** RFC-3339 time asserted by the authority (local: Pharos-set; rfc3161: the TSA's genTime). */
  time: string;
  /** Which authority produced this. Absent ⇒ legacy `local`. */
  provider?: "local" | "rfc3161";
  // local provider:
  keyId?: string;
  signature?: string;
  // rfc3161 provider:
  /** Base64 DER RFC 3161 TimeStampToken (self-verifiable against the embedded TSA cert). */
  token?: string;
}

function tokenMessage(hash: string, time: string): Buffer {
  return Buffer.from(sha256Hex({ hash, time }), "utf8");
}

/** A trusted-time authority that stamps a hash and returns a verifiable {@link TrustedTimestamp}. */
export interface TsaProvider {
  readonly kind: "local" | "rfc3161";
  timestamp(hash: string): Promise<TrustedTimestamp>;
}

/** Simulated TSA backed by a {@link SigningProvider} — the hermetic `local` provider. */
export class LocalTsa implements TsaProvider {
  readonly kind = "local" as const;
  constructor(
    private readonly signer: SigningProvider,
    private readonly keyName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async timestamp(hash: string): Promise<TrustedTimestamp> {
    const time = this.now().toISOString();
    const keyId = await this.signer.ensureKey(this.keyName);
    const signature = await this.signer.sign(keyId, tokenMessage(hash, time));
    return { hash, time, provider: "local", keyId, signature };
  }
}

/** Real RFC 3161 TSA client. */
export class Rfc3161Tsa implements TsaProvider {
  readonly kind = "rfc3161" as const;
  constructor(
    private readonly url: string,
    private readonly opts: Rfc3161Options = {},
  ) {}

  async timestamp(hash: string): Promise<TrustedTimestamp> {
    const { tokenBase64, genTime } = await requestTimestamp(this.url, hash, this.opts);
    return { hash, time: genTime, provider: "rfc3161", token: tokenBase64 };
  }
}

/**
 * Backward-compatible helper: create a `local` timestamp with an explicit time. Prefer
 * {@link TsaProvider.timestamp}; kept because callers passed a SigningProvider + time directly.
 */
export async function createTimestamp(
  tsa: SigningProvider,
  tsaKeyName: string,
  hash: string,
  time: string,
): Promise<TrustedTimestamp> {
  const keyId = await tsa.ensureKey(tsaKeyName);
  const signature = await tsa.sign(keyId, tokenMessage(hash, time));
  return { hash, time, provider: "local", keyId, signature };
}

/**
 * Verify a timestamp offline. `verifyLocalKeyset` checks a local-provider signature against the
 * TSA's published public key (the same keyset verifier used for chain signatures); rfc3161
 * tokens are self-verifiable against their embedded TSA cert and ignore it.
 */
export function verifyTimestamp(
  ts: TrustedTimestamp,
  verifyLocalKeyset: (keyId: string, message: Buffer, signature: string) => boolean,
): boolean {
  if (ts.provider === "rfc3161") {
    if (!ts.token) return false;
    const verdict = verifyRfc3161Token(Buffer.from(ts.token, "base64"), ts.hash);
    // The token's own genTime is authoritative; require it to match the recorded time.
    return verdict.valid && verdict.genTime === ts.time;
  }
  // local (or legacy, provider absent)
  if (!ts.keyId || !ts.signature) return false;
  return verifyLocalKeyset(ts.keyId, tokenMessage(ts.hash, ts.time), ts.signature);
}
