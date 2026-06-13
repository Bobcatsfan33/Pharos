/**
 * Roles and permissions as product primitives.
 *
 * Deny-by-default: a principal can do nothing unless a role or scope grants it. Every
 * server route declares the permission it requires; the auth layer checks it before the
 * handler runs. There is no "dev-user" and no implicit admin.
 */

export const ROLES = [
  "tenant_admin",
  "policy_author",
  "reviewer",
  "risk_owner",
  "counsel",
  "external_auditor",
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "actions:write", // submit agent actions for a verdict (ingestion)
  "records:read", // read sealed evidence
  "records:export", // export evidence (claims packs, downloads)
  "chain:verify", // run chain verification
  "policies:read",
  "policies:write",
  "reviews:read",
  "reviews:act", // approve/modify/reject escalations
  "tenants:manage", // tenant lifecycle
  "keys:manage", // create/rotate/revoke API keys
  "audit:read", // read the access audit log
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = (): Permission[] => [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  tenant_admin: ALL(),
  policy_author: ["policies:read", "policies:write", "records:read", "chain:verify"],
  reviewer: ["reviews:read", "reviews:act", "records:read", "chain:verify"],
  risk_owner: ["records:read", "audit:read", "chain:verify", "policies:read"],
  counsel: ["records:read", "records:export", "audit:read", "chain:verify"],
  // External auditors are strictly read-scoped.
  external_auditor: ["records:read", "chain:verify", "audit:read"],
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function permissionsForRoles(roles: Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role]) out.add(p);
  return out;
}
