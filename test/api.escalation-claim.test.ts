import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerEscalationRoutes } from "../services/api/src/routes/escalations.js";
import type { Platform } from "../services/api/src/platform.js";

describe("escalation claim API", () => {
  it("replays ownership for one stable claimant and refuses a competitor", async () => {
    let owner: string | null = null;
    const escalation = {
      id: "e1",
      tenantId: "acme",
      status: "approved",
      resolution: null,
      resumedAt: null,
      resumeClaimId: null,
    };
    const platform = {
      config: {
        api: { rateLimitPerMin: 100, rateLimitTenantPerMin: 100, rateLimitFailMode: "closed" },
      },
      cache: { incr: async () => 1 },
      apiKeys: {
        verify: async () => ({
          keyId: "runtime-key",
          tenantId: "acme",
          scopes: ["actions:write"],
        }),
      },
      escalations: {
        get: async () => escalation,
        claimResume: async (_tenant: string, _id: string, claimId?: string) => {
          if (!claimId || (owner !== null && owner !== claimId)) return null;
          owner ??= claimId;
          return { ...escalation, resumedAt: new Date().toISOString(), resumeClaimId: owner };
        },
      },
    } as unknown as Platform;
    const app = Fastify();
    registerEscalationRoutes(app, platform);

    const claim = (claimId: string) =>
      app.inject({
        method: "POST",
        url: "/v1/tenants/acme/escalations/e1/claim",
        headers: { "x-api-key": "key" },
        payload: { claimId },
      });

    expect((await claim("keel:claim:v1:a")).json().data.claimed).toBe(true);
    expect((await claim("keel:claim:v1:a")).json().data.claimed).toBe(true);
    expect((await claim("keel:claim:v1:b")).json().data.claimed).toBe(false);
    await app.close();
  });

  it("rejects an empty claim identity", async () => {
    const platform = {
      config: {
        api: { rateLimitPerMin: 100, rateLimitTenantPerMin: 100, rateLimitFailMode: "closed" },
      },
      cache: { incr: async () => 1 },
      apiKeys: {
        verify: async () => ({
          keyId: "runtime-key",
          tenantId: "acme",
          scopes: ["actions:write"],
        }),
      },
    } as unknown as Platform;
    const app = Fastify();
    registerEscalationRoutes(app, platform);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tenants/acme/escalations/e1/claim",
      headers: { "x-api-key": "key" },
      payload: { claimId: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    await app.close();
  });
});
