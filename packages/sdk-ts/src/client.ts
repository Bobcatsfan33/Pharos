import {
  type ClaimResult,
  type Escalation,
  type MandateRootKey,
  type SubmitInput,
  type SubmitResult,
  type TelemetryEvent,
  type Verdict,
  PharosError,
} from "./types.js";
import { validateSubmitInput } from "./validate.js";
import { scopeAllowsActionType, verifyMandateToken } from "./mandateToken.js";

export interface MandateTokenClientOptions {
  /**
   * The tenant's published mandate root keys (`GET /v1/keyset`, entries named
   * `mandate:<tenantId>#vN`), or a resolver by keyId. Without them the SDK does not verify
   * tokens locally; the server always does.
   */
  rootKeys: MandateRootKey[] | ((keyId: string) => Promise<MandateRootKey | null>);
  /**
   * Optimistic local allow (default false). When on, a verified token on a reversible,
   * zero-amount action inside the token's scope is allowed locally while the sealed record is
   * submitted asynchronously. The server verdict is authoritative; Tier 2/3 may still disagree,
   * and `result.sealed` / the `local-verdict-diverged` event surface that. Leave this off unless
   * the tenant's policy says otherwise.
   */
  localAllow?: boolean;
}

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
  /** MandateToken handling (Workstream A). Omit to leave verification to the server. */
  mandateToken?: MandateTokenClientOptions;
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
        const json = (await res.json().catch(() => ({}))) as {
          data?: T;
          error?: { code?: string };
        };
        if (!res.ok) {
          // 4xx is a client error — do not retry.
          if (res.status >= 400 && res.status < 500) {
            throw new PharosError(
              `request failed: ${json.error?.code ?? res.statusText}`,
              json.error?.code ?? "client_error",
              res.status,
            );
          }
          throw new PharosError(`server error ${res.status}`, "server_error", res.status);
        }
        return json.data as T;
      } catch (err) {
        lastErr = err;
        if (err instanceof PharosError && err.status && err.status >= 400 && err.status < 500)
          throw err;
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

  private async rootKeyFor(keyId: string): Promise<MandateRootKey | null> {
    const keys = this.opts.mandateToken?.rootKeys;
    if (!keys) return null;
    if (typeof keys === "function") return keys(keyId);
    return keys.find((k) => k.keyId === keyId) ?? null;
  }

  /**
   * Decide locally from the token when the client holds the root keys. Returns null when the
   * server should decide (no keys configured, or the token verified but local allow does not
   * apply). A local decision is still submitted for sealing by the caller.
   */
  private async localTokenVerdict(
    input: SubmitInput,
    start: number,
  ): Promise<{ verdict: Verdict; kind: "mandate-token-invalid" | "mandate-token-allow" } | null> {
    const token = input.mandateToken;
    if (!token || !this.opts.mandateToken) return null;
    const keyId = token.authority?.keyId;
    const root = typeof keyId === "string" ? await this.rootKeyFor(keyId) : null;
    const now = new Date();
    const result = root
      ? await verifyMandateToken(token, root, now, {
          expect: { tenantId: input.tenantId, agentId: input.action.agentId },
        })
      : { ok: false as const, code: "root-key-unknown" as const, effective: null };
    const latency = () => ({
      totalMs: Date.now() - start,
      perTier: {},
      deadlineMs: this.deadlineMs,
      deadlineBreached: false,
    });
    if (!result.ok) {
      this.emit({
        type: "local-verdict",
        verdict: "mandate-token-invalid",
        code: result.code ?? undefined,
      });
      return {
        kind: "mandate-token-invalid",
        verdict: {
          decision: "block",
          tierReached: 1,
          riskScore: 1,
          ruleCitations: [
            {
              ruleId: "mandate-token-invalid",
              pack: "core",
              clause: "liability.mandateToken.verification",
              description: `Presented mandate token was refused: ${result.code}.`,
            },
          ],
          failMode: null,
          judgeVersion: null,
          latency: latency(),
        },
      };
    }
    if (!this.opts.mandateToken.localAllow || !result.effective) return null;
    const br = input.liability.blastRadius;
    const eligible =
      br.reversibility === "reversible" &&
      (br.financialAmount ?? 0) === 0 &&
      scopeAllowsActionType(result.effective.scope, input.action.type) &&
      new Date(result.effective.expiresAt).getTime() > now.getTime();
    if (!eligible) return null;
    this.emit({ type: "local-verdict", verdict: "mandate-token-allow" });
    return {
      kind: "mandate-token-allow",
      verdict: {
        decision: "allow",
        tierReached: 1,
        riskScore: 0,
        ruleCitations: [
          {
            ruleId: "mandate-token-local-allow",
            pack: "sdk",
            clause: "mandateToken.localAllow",
            description:
              "Verified mandate token admitted a reversible, zero-amount, in-scope action locally; the sealed server verdict is authoritative.",
          },
        ],
        failMode: null,
        judgeVersion: null,
        latency: latency(),
      },
    };
  }

  /** Submit an action for a verdict + sealed record. Falls back to a local default if unreachable. */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    // Validate BEFORE transmit and before any fail-mode path (#80). This throws rather
    // than falling back: an unvalidated `liability` would otherwise pick the local
    // fail-mode, so a typo could allow an irreversible action the server never saw.
    validateSubmitInput(input);
    const start = Date.now();

    // MandateToken (Workstream A): a structurally invalid token is a Tier-1 block decided here,
    // without waiting on the network; an optimistic local allow is opt-in. In both cases the
    // very same request is still submitted, so the decision has a sealed record — the server
    // reaches the same block from the token, and may overrule a local allow at Tier 2/3.
    const local = await this.localTokenVerdict(input, start);
    if (local) {
      const sealed = this.submitRemote(input, start).then(
        (r) => {
          if (r.verdict.decision !== local.verdict.decision)
            this.emit({
              type: "local-verdict-diverged",
              local: local.verdict.decision,
              sealed: r.verdict.decision,
            });
          return r;
        },
        (err: unknown) => {
          this.emit({
            type: "local-verdict-diverged",
            local: local.verdict.decision,
            sealed: null,
            error: (err as Error).message,
          });
          throw err;
        },
      );
      sealed.catch(() => undefined); // the caller may ignore `sealed`; never an unhandled rejection
      return {
        verdict: local.verdict,
        record: { content: { id: "local", sequence: -1 } },
        escalation: null,
        localVerdict: local.kind,
        sealed,
      };
    }
    return this.submitRemote(input, start);
  }

  private async submitRemote(input: SubmitInput, start: number): Promise<SubmitResult> {
    try {
      const result = await this.request<SubmitResult>("POST", "/v1/actions", input);
      this.emit({
        type: "submit",
        attempt: 0,
        latencyMs: Date.now() - start,
        decision: result.verdict.decision,
      });
      return result;
    } catch (err) {
      if (err instanceof PharosError && err.status && err.status >= 400 && err.status < 500)
        throw err;
      // Platform unreachable (incl. a 503 kms_unavailable): apply the local fail-mode. Mirror
      // the server cascade — reversible work fails OPEN (allow + local stub), irreversible work
      // fails CLOSED (escalate); fall back to the configured default if reversibility is unknown.
      const reversibility = input.liability?.blastRadius?.reversibility;
      const failMode =
        reversibility === "reversible"
          ? "fail_open"
          : reversibility === "irreversible"
            ? "fail_closed"
            : this.localFailMode;
      this.emit({ type: "fallback", failMode });
      const verdict: Verdict = {
        decision: failMode === "fail_open" ? "allow" : "escalate",
        tierReached: 1,
        riskScore: 0.5,
        ruleCitations: [
          {
            ruleId: `sdk-${failMode}`,
            pack: "sdk",
            description: `Platform unreachable; SDK applied ${failMode}.`,
          },
        ],
        failMode,
        judgeVersion: null,
        latency: {
          totalMs: Date.now() - start,
          perTier: {},
          deadlineMs: this.deadlineMs,
          deadlineBreached: true,
        },
      };
      return {
        verdict,
        record: { content: { id: "local", sequence: -1 } },
        escalation: null,
        localFallback: true,
      };
    }
  }

  async getEscalation(tenantId: string, id: string): Promise<Escalation> {
    const data = await this.request<{ escalation: Escalation }>(
      "GET",
      `/v1/tenants/${tenantId}/escalations/${id}`,
    );
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
      if (Date.now() > deadline)
        throw new PharosError("escalation resolution timed out", "resolution_timeout");
      await sleep(interval);
    }
  }

  /** Claim resume ownership. A stable claimId can be retried after a process crash. */
  async claim(tenantId: string, id: string, claimId?: string): Promise<ClaimResult> {
    const data = await this.request<ClaimResult>(
      "POST",
      `/v1/tenants/${tenantId}/escalations/${id}/claim`,
      claimId ? { claimId } : undefined,
    );
    this.emit({ type: "resume", escalationId: id, claimed: data.claimed });
    return data;
  }

  /**
   * Govern a side effect with an at-most-once resume claim:
   *   - allow                  -> run the side effect once
   *   - block / reject         -> skip
   *   - escalate -> await human -> approve/modify -> claim -> one caller runs; reject -> skip
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

    // Escalate: wait for a human verdict, then atomically select one resumer.
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
