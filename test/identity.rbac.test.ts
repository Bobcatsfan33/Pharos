import { describe, it, expect } from "vitest";
import {
  authorize,
  can,
  effectivePermissions,
  AuthorizationError,
  type Principal,
} from "@pharos/identity";

function user(roles: Principal["roles"], tenantId = "t1"): Principal {
  return { subject: "u1", tenantId, kind: "user", roles, scopes: [] };
}

describe("RBAC + deny-by-default", () => {
  it("tenant_admin has every permission", () => {
    const p = user(["tenant_admin"]);
    expect(can(p, "actions:write")).toBe(true);
    expect(can(p, "keys:manage")).toBe(true);
    expect(can(p, "tenants:manage")).toBe(true);
  });

  it("reviewer can act on reviews but not manage keys", () => {
    const p = user(["reviewer"]);
    expect(can(p, "reviews:act")).toBe(true);
    expect(can(p, "records:read")).toBe(true);
    expect(can(p, "keys:manage")).toBe(false);
    expect(can(p, "policies:write")).toBe(false);
  });

  it("external_auditor is strictly read-scoped", () => {
    const p = user(["external_auditor"]);
    expect(can(p, "records:read")).toBe(true);
    expect(can(p, "chain:verify")).toBe(true);
    expect(can(p, "records:export")).toBe(false);
    expect(can(p, "actions:write")).toBe(false);
  });

  it("a principal with no roles can do nothing (deny-by-default)", () => {
    const p = user([]);
    expect(effectivePermissions(p).size).toBe(0);
    expect(can(p, "records:read")).toBe(false);
  });

  it("API keys are limited to their granted scopes, not roles", () => {
    const key: Principal = {
      subject: "k1",
      tenantId: "t1",
      kind: "api_key",
      roles: ["tenant_admin"],
      scopes: ["actions:write"],
    };
    // Even though roles lists tenant_admin, an api_key resolves to scopes only.
    expect(can(key, "actions:write")).toBe(true);
    expect(can(key, "keys:manage")).toBe(false);
  });

  it("authorize rejects cross-tenant access even for admins", () => {
    const admin = user(["tenant_admin"], "tenant-a");
    expect(() => authorize(admin, "tenant-b", "records:read")).toThrow(AuthorizationError);
    try {
      authorize(admin, "tenant-b", "records:read");
    } catch (e) {
      expect((e as AuthorizationError).code).toBe("tenant_mismatch");
    }
  });

  it("authorize enforces the permission within the right tenant", () => {
    const reviewer = user(["reviewer"], "t1");
    expect(() => authorize(reviewer, "t1", "records:read")).not.toThrow();
    expect(() => authorize(reviewer, "t1", "keys:manage")).toThrow(AuthorizationError);
  });
});
