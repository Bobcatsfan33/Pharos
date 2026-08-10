import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthorizationError, authorize, type Permission, type Principal } from "@pharos/identity";
import type { Platform } from "./platform.js";

/**
 * Request authentication and authorization for the API.
 *
 * Two credential types:
 *   - Bearer <jwt>  → an interactive user, verified via OIDC against a trusted IdP.
 *   - API key       → a machine identity (X-API-Key header or `ApiKey <key>`), scoped.
 *
 * Every protected route declares the permission it needs and the tenant it touches.
 * authorize() enforces deny-by-default and rejects any cross-tenant access — including
 * for tenant admins. Access to evidence is recorded in the hash-chained access audit.
 */
function errorBody(code: string, message: string) {
  return { success: false, data: null, error: { code, message } };
}

export async function authenticate(
  platform: Platform,
  request: FastifyRequest,
): Promise<Principal> {
  const authHeader = request.headers["authorization"];
  const apiKeyHeader = request.headers["x-api-key"];

  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    try {
      return await platform.oidc.verifyBearer(authHeader.slice(7));
    } catch (err) {
      throw new AuthorizationError(
        "unauthenticated",
        `bearer token rejected: ${(err as Error).message}`,
      );
    }
  }

  const apiKey =
    typeof apiKeyHeader === "string"
      ? apiKeyHeader
      : typeof authHeader === "string" && authHeader.startsWith("ApiKey ")
        ? authHeader.slice(7)
        : null;

  if (apiKey) {
    const verified = await platform.apiKeys.verify(apiKey);
    if (!verified) throw new AuthorizationError("unauthenticated", "invalid or revoked API key");
    return {
      subject: verified.keyId,
      tenantId: verified.tenantId,
      kind: "api_key",
      roles: [],
      scopes: verified.scopes,
    };
  }

  throw new AuthorizationError("unauthenticated", "no credentials provided");
}

/**
 * Admission decision for one request.
 *
 * `rate_limited` means the counter store answered and the budget is spent.
 * `rate_limiter_unavailable` means it could not answer at all — a distinct condition,
 * because "we know you are over budget" and "we cannot tell" warrant different
 * responses and different operator alerts.
 */
type RateLimitDecision =
  | { ok: true }
  | { ok: false; code: "rate_limited" }
  | { ok: false; code: "rate_limiter_unavailable" };

/**
 * Fixed-window rate limit, enforced on two axes:
 *
 *   - per principal (tenant + subject), and
 *   - per tenant in aggregate.
 *
 * The tenant axis matters because a tenant that mints N API keys would otherwise
 * multiply its effective ingest budget by N — the per-principal limit alone caps a
 * credential, not a customer.
 *
 * Fail mode: if the counter store is unreachable the request is REFUSED by default.
 * The counter store is the only component that can establish a request is within
 * budget; admitting unmetered traffic when it is down turns "degrade the cache" into
 * "remove the rate limit", which is an attacker-reachable escalation. Production
 * configuration pins this to fail-closed (`api.rateLimitFailMode`).
 */
async function withinRateLimit(
  platform: Platform,
  principal: Principal,
): Promise<RateLimitDecision> {
  const { rateLimitPerMin, rateLimitTenantPerMin, rateLimitFailMode } = platform.config.api;
  try {
    const [principalCount, tenantCount] = await Promise.all([
      platform.cache.incr(`rl:p:${principal.tenantId}:${principal.subject}`, 60),
      platform.cache.incr(`rl:t:${principal.tenantId}`, 60),
    ]);
    if (principalCount > rateLimitPerMin) return { ok: false, code: "rate_limited" };
    if (tenantCount > rateLimitTenantPerMin) return { ok: false, code: "rate_limited" };
    return { ok: true };
  } catch {
    if (rateLimitFailMode === "open") return { ok: true };
    return { ok: false, code: "rate_limiter_unavailable" };
  }
}

/**
 * Authenticate, rate-limit, and authorize a request for `permission` on `tenantId`.
 * On any failure, sends the appropriate response and returns null; the caller must stop.
 */
export async function requireAuth(
  platform: Platform,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
  tenantId: string,
): Promise<Principal | null> {
  let principal: Principal;
  try {
    principal = await authenticate(platform, request);
  } catch (err) {
    reply.status(401).send(errorBody("unauthenticated", (err as Error).message));
    return null;
  }

  const admission = await withinRateLimit(platform, principal);
  if (!admission.ok) {
    if (admission.code === "rate_limiter_unavailable") {
      // 503, not 429: the caller is not necessarily over budget — admission control
      // itself is down. Retryable, and distinguishable in operator dashboards.
      reply
        .status(503)
        .send(
          errorBody(
            "rate_limiter_unavailable",
            "request admission control is temporarily unavailable",
          ),
        );
      return null;
    }
    reply.status(429).send(errorBody("rate_limited", "request rate limit exceeded"));
    return null;
  }

  try {
    authorize(principal, tenantId, permission);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      const status = err.code === "tenant_mismatch" ? 403 : 403;
      reply.status(status).send(errorBody(err.code, err.message));
      return null;
    }
    throw err;
  }
  return principal;
}

/**
 * Constant-time equality for two secrets of unknown length.
 *
 * Both sides are reduced to a SHA-256 digest first, for two reasons: `timingSafeEqual`
 * throws when the buffers differ in length, and comparing the raw secrets behind a
 * length guard would still leak the expected token's length through the early return.
 * Hashing makes every comparison exactly 32 bytes wide regardless of input.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Platform-operator bootstrap guard for tenant provisioning.
 *
 * The admin token is the highest-privilege credential in the system, so the comparison
 * is constant-time (#75). A `!==` on two strings short-circuits at the first differing
 * byte, and that timing difference is the signal an attacker uses to recover a secret
 * one byte at a time.
 */
export function requireAdminToken(
  platform: Platform,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const token = request.headers["x-pharos-admin"];
  const admin = platform.config.admin;
  if (!admin.token) {
    // Unconfigured is refused, never treated as "no token required".
    reply.status(503).send(errorBody("admin_disabled", "platform admin token not configured"));
    return false;
  }
  if (typeof token !== "string") {
    reply.status(401).send(errorBody("unauthenticated", "invalid platform admin token"));
    return false;
  }

  const now = Date.now();
  const credentials = [
    { token: admin.token, expiresAt: admin.tokenExpiresAt },
    ...(admin.previousToken
      ? [{ token: admin.previousToken, expiresAt: admin.previousTokenExpiresAt }]
      : []),
  ];
  // Evaluate every configured credential even after a match. This preserves the
  // constant-time comparison guarantee during the overlap window and avoids revealing
  // whether the caller presented the current or previous credential.
  let accepted = false;
  for (const credential of credentials) {
    const matches = secretsMatch(token, credential.token);
    const unexpired = !credential.expiresAt || Date.parse(credential.expiresAt) > now;
    accepted = (matches && unexpired) || accepted;
  }
  if (!accepted) {
    reply.status(401).send(errorBody("unauthenticated", "invalid or expired platform admin token"));
    return false;
  }
  return true;
}
