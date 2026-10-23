import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "@pharos/config";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pharos-config-embedded-"));
  dirs.push(d);
  return d;
};

describe("embedded storage configuration", () => {
  it("needs zero variables beyond the backend switch and a data dir", () => {
    const dataDir = tmp();
    const config = loadConfig({ PHAROS_STORAGE_BACKEND: "embedded", PHAROS_DATA_DIR: dataDir });
    expect(config.storage).toEqual({ backend: "embedded", dataDir });
    expect(config.pg.url).toBeUndefined();
    expect(config.redis.url).toBeUndefined();
    expect(config.s3.endpoint).toBeUndefined();
    expect(config.kms.provider).toBe("local-kms");
    expect(config.kms.keystoreDir).toBe(join(dataDir, "keystore"));
    // The generated passphrase lives beside the keystore (documented dev posture), mode 0600,
    // and is stable across loads so the keystore stays readable.
    const file = join(dataDir, "keystore.passphrase");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(config.kms.keystorePassphrase);
    expect(config.kms.keystorePassphrase!.length).toBeGreaterThanOrEqual(16);
    const again = loadConfig({ PHAROS_STORAGE_BACKEND: "embedded", PHAROS_DATA_DIR: dataDir });
    expect(again.kms.keystorePassphrase).toBe(config.kms.keystorePassphrase);
  });

  it("an explicit passphrase wins and no file is written", () => {
    const dataDir = tmp();
    const config = loadConfig({
      PHAROS_STORAGE_BACKEND: "embedded",
      PHAROS_DATA_DIR: dataDir,
      PHAROS_KMS_KEYSTORE_PASSPHRASE: "an-explicit-passphrase-from-a-keychain",
    });
    expect(config.kms.keystorePassphrase).toBe("an-explicit-passphrase-from-a-keychain");
    expect(() => statSync(join(dataDir, "keystore.passphrase"))).toThrow(/ENOENT/);
  });

  it("the postgres backend (default) still requires its infrastructure variables, and says how to avoid them", () => {
    expect(() =>
      loadConfig({ PHAROS_KMS_KEYSTORE_PASSPHRASE: "pharos-test-keystore-passphrase" }),
    ).toThrow(
      /PHAROS_PG_URL is required for the postgres storage backend.*PHAROS_STORAGE_BACKEND=embedded/s,
    );
  });

  it("production refuses the embedded backend", () => {
    expect(() =>
      loadConfig({
        PHAROS_ENV: "prod",
        PHAROS_STORAGE_BACKEND: "embedded",
        PHAROS_DATA_DIR: tmp(),
        PHAROS_KMS_PROVIDER: "aws-kms",
      }),
    ).toThrow(/production requires the postgres storage backend/);
  });

  it("does not touch the filesystem for the postgres backend", () => {
    const dataDir = join(tmp(), "never-created");
    loadConfig({
      PHAROS_DATA_DIR: dataDir,
      PHAROS_KMS_KEYSTORE_PASSPHRASE: "pharos-test-keystore-passphrase",
      PHAROS_PG_URL: "postgres://localhost/pharos",
      PHAROS_REDIS_URL: "redis://localhost:6379",
      PHAROS_S3_ENDPOINT: "http://localhost:9000",
      PHAROS_S3_REGION: "us-east-1",
      PHAROS_S3_BUCKET: "test",
    });
    expect(() => statSync(dataDir)).toThrow(/ENOENT/);
  });
});
