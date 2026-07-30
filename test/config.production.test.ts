import { describe, expect, it } from "vitest";
import { loadConfig } from "@pharos/config";

function productionEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    PHAROS_ENV: "prod",
    PHAROS_PG_URL: "postgres://pharos@example.internal/pharos?sslmode=verify-full",
    PHAROS_REDIS_URL: "rediss://redis.example.internal:6379",
    PHAROS_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
    PHAROS_S3_REGION: "us-east-1",
    PHAROS_S3_BUCKET: "pharos-evidence",
    PHAROS_KMS_PROVIDER: "aws-kms",
    PHAROS_KMS_AWS_REGION: "us-east-1",
    PHAROS_TSA_PROVIDER: "rfc3161",
    PHAROS_TSA_URL: "https://timestamp.example.internal",
    PHAROS_TSA_CERT_SHA256: "a".repeat(64),
    PHAROS_ADMIN_TOKEN: "a-secure-random-token-with-32-characters",
    ...overrides,
  };
}

describe("production configuration posture", () => {
  it("accepts the required production controls", () => {
    const config = loadConfig(productionEnv());

    expect(config.env).toBe("prod");
    expect(config.kms.provider).toBe("aws-kms");
    expect(config.tsa.provider).toBe("rfc3161");
  });

  it.each([
    ["local KMS", { PHAROS_KMS_PROVIDER: "local-kms" }, "kms.provider"],
    [
      "KMS endpoint overrides",
      { PHAROS_KMS_AWS_ENDPOINT: "http://kms-emulator:8080" },
      "kms.awsEndpoint",
    ],
    ["local timestamps", { PHAROS_TSA_PROVIDER: "local" }, "tsa.provider"],
    ["a missing TSA URL", { PHAROS_TSA_URL: undefined }, "tsa.url"],
    ["a plaintext TSA URL", { PHAROS_TSA_URL: "http://tsa.internal" }, "tsa.url"],
    [
      "a missing TSA certificate pin",
      { PHAROS_TSA_CERT_SHA256: undefined },
      "tsa.trustedCertSha256",
    ],
    [
      "a malformed TSA certificate pin",
      { PHAROS_TSA_CERT_SHA256: "not-a-fingerprint" },
      "tsa.trustedCertSha256",
    ],
    ["disabled anchoring", { PHAROS_TSA_ANCHOR_INTERVAL_MS: "0" }, "tsa.intervalMs"],
    ["plaintext object storage", { PHAROS_S3_ENDPOINT: "http://minio:9000" }, "s3.endpoint"],
    [
      "static AWS S3 credentials",
      { PHAROS_S3_ACCESS_KEY: "access", PHAROS_S3_SECRET_KEY: "secret" },
      "s3.accessKey",
    ],
    [
      "plaintext PostgreSQL",
      { PHAROS_PG_URL: "postgres://pharos@postgres.internal/pharos" },
      "pg.url",
    ],
    [
      "PostgreSQL encryption without certificate verification",
      { PHAROS_PG_URL: "postgres://pharos@postgres.internal/pharos?sslmode=require" },
      "pg.url",
    ],
    ["plaintext Redis", { PHAROS_REDIS_URL: "redis://redis.internal:6379" }, "redis.url"],
    ["a short admin token", { PHAROS_ADMIN_TOKEN: "change-me" }, "admin.token"],
  ])("rejects %s", (_name, override, path) => {
    expect(() => loadConfig(productionEnv(override))).toThrow(path);
  });

  it("preserves hermetic local-development defaults", () => {
    const config = loadConfig({
      PHAROS_ENV: "local",
      PHAROS_PG_URL: "postgres://localhost/pharos",
      PHAROS_REDIS_URL: "redis://localhost:6379",
      PHAROS_S3_ENDPOINT: "http://localhost:9000",
      PHAROS_S3_REGION: "us-east-1",
      PHAROS_S3_BUCKET: "test",
      PHAROS_S3_ACCESS_KEY: "test",
      PHAROS_S3_SECRET_KEY: "test",
    });

    expect(config.kms.provider).toBe("local-kms");
    expect(config.tsa.provider).toBe("local");
  });

  it("accepts paired static credentials for self-hosted local object storage", () => {
    const config = loadConfig({
      PHAROS_ENV: "local",
      PHAROS_PG_URL: "postgres://localhost/pharos",
      PHAROS_REDIS_URL: "redis://localhost:6379",
      PHAROS_S3_ENDPOINT: "http://localhost:9000",
      PHAROS_S3_REGION: "us-east-1",
      PHAROS_S3_BUCKET: "test",
      PHAROS_S3_ACCESS_KEY: "minio",
      PHAROS_S3_SECRET_KEY: "minio-secret",
    });

    expect(config.s3.accessKey).toBe("minio");
  });

  it("rejects a partial static credential pair", () => {
    expect(() =>
      loadConfig({
        PHAROS_ENV: "local",
        PHAROS_PG_URL: "postgres://localhost/pharos",
        PHAROS_REDIS_URL: "redis://localhost:6379",
        PHAROS_S3_ENDPOINT: "http://localhost:9000",
        PHAROS_S3_REGION: "us-east-1",
        PHAROS_S3_BUCKET: "test",
        PHAROS_S3_ACCESS_KEY: "orphaned-access-key",
      }),
    ).toThrow("S3 static credentials must provide both");
  });

  const oidcIssuer = {
    issuer: "https://login.example.com",
    audience: "pharos",
    jwksUri: "https://login.example.com/.well-known/jwks.json",
    claims: { tenant: "pharos_tenant", roles: "pharos_roles" },
  };

  it("accepts a typed HTTPS OIDC issuer in production", () => {
    const config = loadConfig(productionEnv({ PHAROS_OIDC_ISSUERS: JSON.stringify([oidcIssuer]) }));
    expect(config.oidc[0]?.issuer).toBe(oidcIssuer.issuer);
    expect(config.oidc[0]?.jwksTimeoutMs).toBe(5_000);
    expect(config.oidc[0]?.jwksCooldownMs).toBe(30_000);
    expect(config.oidc[0]?.jwksCacheMaxAgeMs).toBe(600_000);
  });

  it.each([
    ["fetch timeout", { jwksTimeoutMs: 99 }],
    ["refresh cooldown", { jwksCooldownMs: 300_001 }],
    ["cache lifetime", { jwksCacheMaxAgeMs: 999 }],
  ])("rejects an unsafe OIDC %s bound", (_name, override) => {
    expect(() =>
      loadConfig(
        productionEnv({
          PHAROS_OIDC_ISSUERS: JSON.stringify([{ ...oidcIssuer, ...override }]),
        }),
      ),
    ).toThrow("oidc.0");
  });

  it.each([
    ["plaintext issuer", { ...oidcIssuer, issuer: "http://login.example.com" }, "oidc.0.issuer"],
    [
      "plaintext JWKS",
      { ...oidcIssuer, jwksUri: "http://login.example.com/jwks.json" },
      "oidc.0.jwksUri",
    ],
    [
      "inline signing keys",
      {
        ...oidcIssuer,
        jwksUri: undefined,
        jwks: { keys: [{ kty: "RSA", n: "test", e: "AQAB" }] },
      },
      "oidc.0.jwksUri",
    ],
  ])("rejects production OIDC with %s", (_name, issuer, path) => {
    expect(() =>
      loadConfig(productionEnv({ PHAROS_OIDC_ISSUERS: JSON.stringify([issuer]) })),
    ).toThrow(path);
  });

  it("rejects duplicate production issuer entries", () => {
    expect(() =>
      loadConfig(
        productionEnv({
          PHAROS_OIDC_ISSUERS: JSON.stringify([oidcIssuer, oidcIssuer]),
        }),
      ),
    ).toThrow("oidc.1.issuer");
  });
});
