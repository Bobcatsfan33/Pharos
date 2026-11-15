import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfig } from "@pharos/config";

/**
 * The Okta and Entra snippets in docs/identity-and-tenancy.md are copy-pasteable, so they are
 * pinned here: the doc's JSON must load under the real config schema, and the doc must not
 * drift from the file. A reviewer wiring SSO from the doc alone is the acceptance criterion
 * (#50), and this is what keeps that true.
 */
const DOC = "docs/identity-and-tenancy.md";

/** Every ```json block in the doc that looks like a PHAROS_OIDC_ISSUERS value. */
function oidcBlocksFromDoc(): unknown[][] {
  const md = readFileSync(DOC, "utf8");
  const blocks: unknown[][] = [];
  for (const m of md.matchAll(/```json\n([\s\S]*?)```/g)) {
    const text = m[1]!.trim();
    if (!text.startsWith("[")) continue;
    const parsed = JSON.parse(text) as unknown[];
    if (Array.isArray(parsed) && parsed.some((e) => typeof e === "object" && e && "issuer" in e)) {
      blocks.push(parsed);
    }
  }
  return blocks;
}

const base = {
  PHAROS_ENV: "local",
  PHAROS_KMS_KEYSTORE_PASSPHRASE: "pharos-test-keystore-passphrase",
  PHAROS_PG_URL: "postgres://localhost/pharos",
  PHAROS_REDIS_URL: "redis://localhost:6379",
  PHAROS_S3_ENDPOINT: "http://localhost:9000",
  PHAROS_S3_REGION: "us-east-1",
  PHAROS_S3_BUCKET: "test",
};

describe("documented OIDC issuer examples (#50)", () => {
  const blocks = oidcBlocksFromDoc();

  it("the doc actually contains an issuer example", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("every documented example validates against packages/config", () => {
    for (const issuers of blocks) {
      const cfg = loadConfig({ ...base, PHAROS_OIDC_ISSUERS: JSON.stringify(issuers) });
      expect(cfg.oidc.length).toBe(issuers.length);
      for (const entry of cfg.oidc) {
        expect(entry.audience.length).toBeGreaterThan(0);
        expect(entry.claims.tenant.length).toBeGreaterThan(0);
        expect(entry.claims.roles.length).toBeGreaterThan(0);
        // Remote JWKS, not inline keys: the schema requires exactly one, and production
        // refuses inline signing keys outright.
        expect(entry.jwksUri).toBeTruthy();
      }
    }
  });

  it("the documented examples also satisfy the production rules (HTTPS, unique, remote JWKS)", () => {
    for (const issuers of blocks) {
      const cfg = loadConfig({
        ...base,
        PHAROS_ENV: "prod",
        PHAROS_KMS_PROVIDER: "aws-kms",
        PHAROS_TSA_PROVIDER: "rfc3161",
        PHAROS_JUDGE_PROVIDER: "onnx",
        PHAROS_OIDC_ISSUERS: JSON.stringify(issuers),
        // Everything else production demands, so the only thing under test is the OIDC block.
        PHAROS_PG_URL: "postgres://u:p@db/pharos?sslmode=verify-full",
        PHAROS_REDIS_URL: "rediss://cache:6380",
        PHAROS_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
        PHAROS_ADMIN_TOKEN: "a".repeat(48),
        PHAROS_ADMIN_TOKEN_EXPIRES_AT: "2099-12-31T23:59:59Z",
        PHAROS_TLS_TERMINATOR: "alb",
        PHAROS_TSA_CERT_SHA256: "f".repeat(64),
        PHAROS_JUDGE_DRIFT_PROFILE_PATH: "docs/internal/evidence/judge-drift-profile.json",
        PHAROS_TSA_URL: "https://tsa.example.com/tsr",
        PHAROS_JUDGE_MODEL_DIR: "/var/lib/pharos/judges",
      });
      expect(cfg.oidc.length).toBe(issuers.length);
      expect(new Set(cfg.oidc.map((e) => e.issuer)).size).toBe(issuers.length);
    }
  });
});
