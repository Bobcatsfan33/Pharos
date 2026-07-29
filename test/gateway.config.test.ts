import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadGatewayDurabilityConfig, loadGatewayServerConfig } from "@pharos/gateway";

describe("gateway durable-store production gate", () => {
  for (const environment of ["prod", "production"]) {
    it(`fails closed for PHAROS_ENV=${environment} when durable state is incomplete`, () => {
      expect(() => loadGatewayDurabilityConfig({ PHAROS_ENV: environment })).toThrow(
        /requires PHAROS_PG_URL and PHAROS_GATEWAY_HOLD_MASTER_KEY_B64/,
      );
    });
  }

  it("accepts a database plus a 32-byte external master key", () => {
    const masterKey = randomBytes(32);
    expect(
      loadGatewayDurabilityConfig({
        PHAROS_ENV: "prod",
        PHAROS_PG_URL: "postgres://example",
        PHAROS_GATEWAY_HOLD_MASTER_KEY_B64: masterKey.toString("base64"),
      }),
    ).toEqual({ pgUrl: "postgres://example", masterKey });
  });

  it("rejects a short encryption key before opening the database", () => {
    expect(() =>
      loadGatewayDurabilityConfig({
        PHAROS_ENV: "prod",
        PHAROS_PG_URL: "postgres://example",
        PHAROS_GATEWAY_HOLD_MASTER_KEY_B64: randomBytes(16).toString("base64"),
      }),
    ).toThrow(/at least 32 bytes/);
  });

  it("rejects malformed base64 instead of silently decoding it", () => {
    expect(() =>
      loadGatewayDurabilityConfig({
        PHAROS_ENV: "prod",
        PHAROS_PG_URL: "postgres://example",
        PHAROS_GATEWAY_HOLD_MASTER_KEY_B64: "not-a-base64-secret!!!",
      }),
    ).toThrow(/valid canonical base64/);
  });

  it("allows the in-memory adapter only outside production", () => {
    expect(loadGatewayDurabilityConfig({ PHAROS_ENV: "local" })).toBeNull();
  });
});

describe("gateway server production gate", () => {
  const completeProductionEnv = {
    PHAROS_ENV: "prod",
    PHAROS_API_BASE: "http://pharos-api",
    PHAROS_API_KEY: "secret",
    PHAROS_TENANT: "tenant-a",
    GATEWAY_AGENT_ID: "agent-a",
    GATEWAY_TARGET: "https://upstream.example.test/v1",
    GATEWAY_PORT: "4100",
    PHAROS_VERDICT_DEADLINE_MS: "800",
  };

  it.each([
    "PHAROS_API_BASE",
    "PHAROS_API_KEY",
    "PHAROS_TENANT",
    "GATEWAY_AGENT_ID",
    "GATEWAY_TARGET",
  ])("requires %s in production", (name) => {
    const env = { ...completeProductionEnv };
    delete env[name as keyof typeof env];
    expect(() => loadGatewayServerConfig(env)).toThrow(`production gateway requires ${name}`);
  });

  it("rejects unsafe URL credentials and invalid numeric bounds", () => {
    expect(() =>
      loadGatewayServerConfig({
        ...completeProductionEnv,
        GATEWAY_TARGET: "https://user:password@upstream.example.test",
      }),
    ).toThrow("GATEWAY_TARGET must not contain credentials");
    expect(() =>
      loadGatewayServerConfig({ ...completeProductionEnv, GATEWAY_PORT: "70000" }),
    ).toThrow("GATEWAY_PORT must be between 1 and 65535");
  });

  it("returns normalized explicit production configuration", () => {
    expect(loadGatewayServerConfig(completeProductionEnv)).toMatchObject({
      apiBase: "http://pharos-api",
      tenantId: "tenant-a",
      target: "https://upstream.example.test/v1",
      port: 4100,
      verdictDeadlineMs: 800,
    });
  });
});
