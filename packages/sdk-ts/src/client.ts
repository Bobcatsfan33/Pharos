import {
  type ClaimResult,
  type Escalation,
  type SubmitInput,
  type SubmitResult,
  type TelemetryEvent,
  type Verdict,
  PharosError,
} from "./types.js";

export interface PharosClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request deadline; the SDK aborts the call when it elapses. Default 800ms. */
  deadlineMs?: number;
  /** Retries on network errors / 5xx (not on 4xx). Default 2. */
  maxRetries?: number;
  /**
   * Local fail-mode default when the platform is unreachable after retries:
   *   "fail_open"   -> allow (for reversible, low-stakes work)
   *   "fail_closed" -> escalate (safe default; recommended)
   * Default "fail_closed".
   */
  localFailMode?: "fail_open" | "fail_closed";
  onEvent?: (event: TelemetryEvent) => void;
  fetchImpl?: typeof fetch;
}

/**
 * The Pharos client. Submit an agent action for a verdict + sealed record, honoring the
 * verdict deadline, retrying transient failures, and falling back to a safe local default
 * if the platform is unreachable. Also drives workflow continuation (await + resume).
 */
export class PharosClient {
  private readonly deadlineMs: number;
  private readonly maxRetries: number;
  private readonly localFailMode: "fail_open" | "fail_closed";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PharosClientOptions) {
    this.deadlineMs = opts.deadlineMs ?? 800;
    this.maxRetries = opts.maxRetries ?? 2;
    this.localFailMode = opts.localFailMode ?? "fail_closed";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private emit(e: TelemetryEvent): void {
    this.opts.onEvent?.(e);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.deadlineMs);
      try {
        const headers: Record<string, string> = { "x-api-key": this.opts.apiKey };
        if (body !== undefined) headers["content-type"] = "application/json";
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string } };
        if (!res.ok) {
          // 4xx is a client error — do not retry.
          if (res.status >= 400 && res.status < 500) {
            throw new PharosError(`request failed: ${json.error?.code ?? res.statusText}`, json.error?.code ?? "client_error", res.status);
          }
          throw new PharosError(`server error ${res.status}`, "server_error", res.status);
        }
        return json.data as T;
      } catch (err) {
        lastErr = err;
        if (err instanceof PharosError && err.status && err.status >= 400 && err.status < 500) throw err;
        if (attempt < this.maxRetries) {
          this.emit({ type: "retry", attempt, error: (err as Error).message });
          await sleep(2 ** attempt * 25);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new PharosError("request failed", "unknown");
  }

  /** Submit an action for a verdict + sealed record. Falls back to a local default if unreachable. */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const start = Date.now();
    try {
      const result = await this.request<SubmitResult>("POST", "/v1/actions", input);
      this.emit({ type: "submit", attempt: 0, latencyMs: Date.now() - start, decision: result.verdict.decision });
      return result;
    } catch (err) {
      if (err instanceof PharosError && err.status && err.status >= 400 && err.status < 500) throw err;
      // Platform unreachable: apply the configured local fail-mode default.
      const failMode = this.localFailMode;
      this.emit({ type: "fallback", failMode });
      const verdict: Verdict = {
        decision: failMode === "fail_open" ? "allow" : "escalate",
        tierReached: 1,
        riskScore: 0.5,
        ruleCitations: [{ ruleId: `sdk-${failMode}`, pack: "sdk", description: `Platform unreachable; SDK applied ${failMode}.` }],
        failMode,
        judgeVersion: null,
        latency: { totalMs: Date.now() - start, perTier: {}, deadlineMs: this.deadlineMs, deadlineBreached: true },
      };
      return { verdict, record: { content: { id: "local", sequence: -1 } }, escalation: null, localFallback: true };
    }
  }

  async getEscalation(tenantId: string, id: string): Promise<Escalation> {
    const data = await this.request<{ escalation: Escalation }>("GET", `/v1/tenants/${tenantId}/escalations/${id}`);
    return data.escalation;
  }

  /** Poll until the escalation is resolved (or the timeout elapses). */
  async awaitResolution(
    tenantId: string,
    id: string,
    opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<Escalation> {
    const interval = opts.pollIntervalMs ?? 500;
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    for (;;) {
      const esc = await this.getEscalation(tenantId, id);
      if (esc.status !== "pending") return esc;
      if (Date.now() > deadline) throw new PharosError("escalation resolution timed out", "resolution_timeout");
      await sleep(interval);
    }
  }

  /** Atomically claim the right to resume — exactly one claim succeeds across all callers. */
  async claim(tenantId: string, id: string): Promise<ClaimResult> {
    const data = await this.request<ClaimResult>("POST", `/v1/tenants/${tenantId}/escalations/${id}/claim`);
    this.emit({ type: "resume", escalationId: id, claimed: data.claimed });
    return data;
  }

  /**
   * Govern a side effect end-to-end with exactly-once semantics:
   *   - allow                  -> run the side effect once
   *   - block / reject         -> skip
   *   - escalate -> await human -> approve/modify -> claim -> run exactly once; reject -> skip
   *
   * `sideEffect` receives the (possibly modified) action and runs at most once.
   */
  async govern(
    input: SubmitInput,
    sideEffect: (action: SubmitInput["action"]) => Promise<void> | void,
    awaitOpts?: { pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<{ outcome: "executed" | "skipped"; reason: string }> {
    const submitted = await this.submit(input);
    const decision = submitted.verdict.decision;

    if (decision === "allow") {
      await sideEffect(input.action);
      return { outcome: "executed", reason: "allowed" };
    }
    if (decision === "block") return { outcome: "skipped", reason: "blocked" };
    if (decision === "modify") {
      await sideEffect(input.action);
      return { outcome: "executed", reason: "modified" };
    }

    // escalate: wait for a human verdict, then resume exactly once.
    if (!submitted.escalation) return { outcome: "skipped", reason: "escalated-no-handle" };
    const resolved = await this.awaitResolution(input.tenantId, submitted.escalation.id, awaitOpts);
    if (resolved.status === "rejected") return { outcome: "skipped", reason: "rejected" };

    const claim = await this.claim(input.tenantId, submitted.escalation.id);
    if (!claim.claimed) return { outcome: "skipped", reason: "already-resumed" };

    const modified = claim.resolution?.modifiedAction as SubmitInput["action"] | undefined;
    await sideEffect(modified ?? input.action);
    return { outcome: "executed", reason: resolved.status };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
