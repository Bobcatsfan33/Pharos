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

/** Best-effort per-principal fixed-window rate limit. Fails open if the cache is down. */
async function withinRateLimit(platform: Platform, principal: Principal): Promise<boolean> {
  try {
    const key = `rl:${principal.tenantId}:${principal.subject}`;
    const count = await platform.cache.incr(key, 60);
    return count <= platform.config.api.rateLimitPerMin;
  } catch {
    return true;
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

  if (!(await withinRateLimit(platform, principal))) {
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

/** Platform-operator bootstrap guard for tenant provisioning. */
export function requireAdminToken(
  platform: Platform,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const token = request.headers["x-pharos-admin"];
  const expected = platform.config.admin.token;
  if (!expected) {
    reply.status(503).send(errorBody("admin_disabled", "platform admin token not configured"));
    return false;
  }
  if (typeof token !== "string" || token !== expected) {
    reply.status(401).send(errorBody("unauthenticated", "invalid platform admin token"));
    return false;
  }
  return true;
}
