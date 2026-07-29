import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadGatewayDurabilityConfig } from "@pharos/gateway";

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
