import { type SigningProvider, type PublicKeyEntry } from "./provider.js";

/**
 * Raised when the KMS is unreachable at seal time. The invariant is non-negotiable: no verdict
 * without a durably-sealed record, so a KMS outage means the action cannot be governed — the
 * API surfaces this as 503, never a queued "sign later" (that would trade away the product).
 */
export class KmsUnavailableError extends Error {
  readonly code = "kms_unavailable";
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "KmsUnavailableError";
  }
}

/**
 * Heuristic: is this error a KMS *connectivity* failure (endpoint down / network / timeout),
 * as opposed to a normal service error (e.g. bad key)? We fail-closed to 503 only for the
 * former. Matches AWS SDK v3 connectivity error shapes and Node socket errno codes.
 */
export function isKmsConnectivityError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string; $metadata?: unknown };
  const name = e?.name ?? "";
  const code = e?.code ?? "";
  if (
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(code)
  ) {
    return true;
  }
  if (
    ["TimeoutError", "RequestTimeout", "NetworkingError", "AbortError"].includes(name) ||
    /timeout|network|socket hang up|getaddrinfo|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN/i.test(
      e?.message ?? "",
    )
  ) {
    return true;
  }
  return false;
}

export interface CircuitBreakerOptions {
  /** Consecutive connectivity failures before the breaker opens. */
  failureThreshold?: number;
  /** How long the breaker stays open before a single trial (half-open), ms. */
  cooldownMs?: number;
  /** Monotonic clock (ms). Injectable for tests. */
  now?: () => number;
}

type BreakerState = "closed" | "open" | "half-open";

/**
 * A minimal circuit breaker. After `failureThreshold` consecutive connectivity failures it
 * opens and short-circuits calls (fail fast, don't hammer a down KMS) for `cooldownMs`, then
 * allows one trial (half-open). Any success closes it.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** True if a call should be short-circuited right now (breaker open, still in cooldown). */
  shouldShortCircuit(): boolean {
    if (this.state === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half-open";
    }
    return this.state === "open";
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half-open" || this.consecutiveFailures >= this.threshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  get status(): BreakerState {
    return this.state;
  }
}

export interface ResilientSignerOptions extends CircuitBreakerOptions {
  /** Called once each time a connectivity failure is classified (increment a metric). */
  onKmsUnavailable?: () => void;
}

/**
 * Wraps any {@link SigningProvider} with a circuit breaker and connectivity-error
 * classification. Connectivity failures (or an open breaker) surface as
 * {@link KmsUnavailableError}; every other error passes through unchanged. Successful calls
 * reset the breaker. This is a decorator — the wrapped provider (LocalKms/AwsKms) stays pure.
 */
export class ResilientSigner implements SigningProvider {
  readonly providerId: string;
  private readonly breaker: CircuitBreaker;
  private readonly onKmsUnavailable?: () => void;

  constructor(
    private readonly inner: SigningProvider,
    opts: ResilientSignerOptions = {},
  ) {
    this.providerId = inner.providerId;
    this.breaker = new CircuitBreaker(opts);
    this.onKmsUnavailable = opts.onKmsUnavailable;
  }

  private async guard<T>(op: () => Promise<T>): Promise<T> {
    if (this.breaker.shouldShortCircuit()) {
      this.onKmsUnavailable?.();
      throw new KmsUnavailableError("KMS circuit breaker is open");
    }
    try {
      const result = await op();
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      if (isKmsConnectivityError(err)) {
        this.breaker.recordFailure();
        this.onKmsUnavailable?.();
        throw new KmsUnavailableError(`KMS unreachable: ${(err as Error).message}`, err);
      }
      throw err;
    }
  }

  ensureKey(keyName: string): Promise<string> {
    return this.guard(() => this.inner.ensureKey(keyName));
  }
  rotate(keyName: string): Promise<string> {
    return this.guard(() => this.inner.rotate(keyName));
  }
  activeKeyId(keyName: string): Promise<string> {
    return this.guard(() => this.inner.activeKeyId(keyName));
  }
  sign(keyId: string, message: Buffer): Promise<string> {
    return this.guard(() => this.inner.sign(keyId, message));
  }
  verify(keyId: string, message: Buffer, signature: string): Promise<boolean> {
    return this.guard(() => this.inner.verify(keyId, message, signature));
  }
  getPublicKey(keyId: string): Promise<PublicKeyEntry | null> {
    return this.guard(() => this.inner.getPublicKey(keyId));
  }
  publishKeyset(): Promise<PublicKeyEntry[]> {
    return this.guard(() => this.inner.publishKeyset());
  }
}
