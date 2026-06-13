import { type Permission, type Role, isPermission, permissionsForRoles } from "./rbac.js";

/**
 * An authenticated principal — either an interactive user (via SSO/OIDC) or a machine
 * identity (via a scoped API key). The principal is always bound to exactly one tenant;
 * that binding is the multi-tenant isolation boundary enforced on every request.
 */
export interface Principal {
  subject: string; // user id (OIDC sub) or api key id
  tenantId: string;
  kind: "user" | "api_key";
  roles: Role[];
  /** API-key granted permissions (machine identities are scoped directly, not by role). */
  scopes: Permission[];
  displayName?: string;
  issuer?: string; // OIDC issuer, for users
}

/**
 * Effective permissions:
 *   - users   → union of their role permissions
 *   - api keys → exactly their granted scopes (least privilege; no role inheritance)
 */
export function effectivePermissions(principal: Principal): Set<Permission> {
  if (principal.kind === "api_key") {
    return new Set(principal.scopes.filter((s) => isPermission(s)));
  }
  return permissionsForRoles(principal.roles);
}

export function can(principal: Principal, permission: Permission): boolean {
  return effectivePermissions(principal).has(permission);
}

/** Authorization error with a stable code for the API layer. */
export class AuthorizationError extends Error {
  constructor(
    public readonly code: "unauthenticated" | "forbidden" | "tenant_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Assert a principal may act on a tenant with a permission. Throws AuthorizationError
 * on any failure — deny-by-default. Cross-tenant access is rejected even for admins.
 */
export function authorize(principal: Principal, tenantId: string, permission: Permission): void {
  if (principal.tenantId !== tenantId) {
    throw new AuthorizationError("tenant_mismatch", `Principal ${principal.subject} cannot access tenant ${tenantId}`);
  }
  if (!can(principal, permission)) {
    throw new AuthorizationError("forbidden", `Principal ${principal.subject} lacks permission ${permission}`);
  }
}
