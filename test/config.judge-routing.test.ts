import { describe, expect, it } from "vitest";
import { loadConfig } from "@pharos/config";

const base = {
  PHAROS_ENV: "local",
  PHAROS_KMS_KEYSTORE_PASSPHRASE: "pharos-test-keystore-passphrase",
  PHAROS_PG_URL: "postgres://localhost/pharos",
  PHAROS_REDIS_URL: "redis://localhost:6379",
  PHAROS_S3_ENDPOINT: "http://localhost:9000",
  PHAROS_S3_REGION: "us-east-1",
  PHAROS_S3_BUCKET: "test",
};

describe("judge routing configuration (D1)", () => {
  it("defaults to strict routing with the structural judge on", () => {
    const c = loadConfig(base);
    expect(c.judge.routing).toBe("strict");
    expect(c.judge.structural).toBe(true);
  });
  it("renders the pre-D1 posture when asked", () => {
    const c = loadConfig({
      ...base,
      PHAROS_JUDGE_ROUTING: "all",
      PHAROS_JUDGE_STRUCTURAL: "false",
    });
    expect(c.judge.routing).toBe("all");
    expect(c.judge.structural).toBe(false);
  });
  it("rejects an unknown routing mode", () => {
    expect(() => loadConfig({ ...base, PHAROS_JUDGE_ROUTING: "some" })).toThrow(/judge\.routing/);
  });
});
