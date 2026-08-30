import { describe, expect, it } from "vitest";
import { RemoteKms, type RemoteSignerTransport } from "@pharos/core";
import {
  planTenantFailover,
  validateEnterpriseDeployment,
  type EnterpriseDeploymentPlan,
} from "@pharos/config";

const plan: EnterpriseDeploymentPlan = {
  regions: [
    { id: "us-east", jurisdiction: "US", replicas: 3 },
    { id: "us-west", jurisdiction: "US", replicas: 3 },
    { id: "eu-west", jurisdiction: "EU", replicas: 3 },
  ],
  tenants: [
    {
      tenantId: "acme",
      allowedJurisdictions: ["US"],
      primaryRegion: "us-east",
      replicaRegions: ["us-west"],
    },
  ],
  kms: { provider: "vault-transit", customerManaged: true, privateEndpoint: true },
  identity: { sso: true, scim: true },
  recovery: { rpoMinutes: 5, rtoMinutes: 30 },
};

describe("enterprise operating plane", () => {
  it("validates residency and chooses a compliant failover", () => {
    expect(validateEnterpriseDeployment(plan)).toEqual({ valid: true, errors: [], warnings: [] });
    expect(planTenantFailover(plan, "acme", "us-east")).toBe("us-west");
    const invalid = structuredClone(plan);
    invalid.tenants[0]!.replicaRegions = ["eu-west"];
    expect(validateEnterpriseDeployment(invalid).errors[0]).toMatch(/residency/);
  });

  it("binds remote signing operations to a tenant namespace", async () => {
    const seen: unknown[] = [];
    const transport: RemoteSignerTransport = {
      ensureKey: async (request) => (seen.push(request), "tenant-key#v1"),
      rotate: async () => "tenant-key#v2",
      activeKeyId: async () => "tenant-key#v1",
      sign: async (request) => (seen.push(request), "signature"),
      verify: async () => true,
      getPublicKey: async () => null,
      publishKeyset: async () => [],
    };
    const kms = new RemoteKms("vault-transit", "tenant/acme", transport);
    await kms.ensureKey("tenant-key");
    await kms.sign("tenant-key#v1", Buffer.from("message"));
    expect(seen).toEqual([
      { namespace: "tenant/acme", keyName: "tenant-key" },
      { namespace: "tenant/acme", keyId: "tenant-key#v1", messageBase64: "bWVzc2FnZQ==" },
    ]);
  });
});
