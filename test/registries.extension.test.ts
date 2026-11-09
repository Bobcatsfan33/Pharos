import { describe, expect, it } from "vitest";
import { loadConfig } from "@pharos/config";
import {
  createSigningProvider,
  hasSigningProvider,
  listSigningProviders,
  registerSigningProvider,
  type PublicKeyEntry,
  type SigningProvider,
} from "@pharos/core";
import {
  createTsaProvider,
  listTsaProviders,
  registerTsaProvider,
  type TsaProvider,
} from "@pharos/evidence";
import {
  createJudgeRegistry,
  listJudgeProviders,
  registerJudgeProvider,
  servedConcerns,
  ModelRegistry,
} from "@pharos/judge";
import {
  createStorageBackend,
  hasStorageBackend,
  listStorageBackends,
  registerStorageBackend,
  type StorageBackend,
} from "@pharos/storage";
import { DEFAULT_PACK_BINDINGS } from "@pharos/cascade";
import { SHIPPED_PACKS, judgeBindingsOf, loadShippedPacks } from "@pharos/policy";
import {
  buildJudgeRegistry,
  buildSigner,
  buildTsaProvider,
  PRODUCTION_JUDGE_CONCERNS,
} from "../services/api/src/platform.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension contract: adding a backend, a pack or a concern is one new file plus one
// registration (or no registration at all, for data discovered from a directory). None of
// these tests touch the composition root; they only register and then ask it to build.

function config(env: Record<string, string>) {
  return loadConfig({
    PHAROS_ENV: "local",
    PHAROS_KMS_KEYSTORE_PASSPHRASE: "pharos-test-keystore-passphrase",
    PHAROS_PG_URL: "postgres://localhost/pharos",
    PHAROS_REDIS_URL: "redis://localhost:6379",
    PHAROS_S3_ENDPOINT: "http://localhost:9000",
    PHAROS_S3_REGION: "us-east-1",
    PHAROS_S3_BUCKET: "test",
    PHAROS_S3_ACCESS_KEY: "test",
    PHAROS_S3_SECRET_KEY: "test",
    ...env,
  });
}

/** A signing backend that lives entirely in this test file. */
class NullSigner implements SigningProvider {
  readonly providerId = "null-hsm";
  constructor(readonly namespace: string) {}
  async ensureKey(keyName: string) {
    return `${keyName}#v1`;
  }
  async rotate(keyName: string) {
    return `${keyName}#v2`;
  }
  async activeKeyId(keyName: string) {
    return `${keyName}#v1`;
  }
  async sign() {
    return "AA==";
  }
  async verify() {
    return true;
  }
  async getPublicKey(keyId: string): Promise<PublicKeyEntry> {
    return { keyId, publicKey: "", algorithm: "ed25519" };
  }
  async publishKeyset(): Promise<PublicKeyEntry[]> {
    return [];
  }
}

describe("storage-backend registry", () => {
  it("ships postgres and embedded and resolves them by configuration", () => {
    expect(listStorageBackends()).toEqual(expect.arrayContaining(["embedded", "postgres"]));
    expect(config({ PHAROS_STORAGE_BACKEND: "embedded" }).storage.backend).toBe("embedded");
    // postgres is the default, and the only backend production accepts.
    expect(config().storage.backend).toBe("postgres");
  });

  it("a new backend is one register call away from the composition root", async () => {
    expect(hasStorageBackend("null-store")).toBe(false);
    const posture = {
      backend: "embedded" as const,
      immutability: "tamper-evident-local-files" as const,
      worm: false,
      rowLevelSecurity: false,
      multiInstanceRateLimits: false,
      description: "test double; stores nothing",
    };
    registerStorageBackend("null-store", async () => ({ posture }) as unknown as StorageBackend);

    const cfg = config({ PHAROS_STORAGE_BACKEND: "null-store" });
    expect(cfg.storage.backend).toBe("null-store");
    const built = await createStorageBackend("null-store", {
      settings: { dataDir: "/tmp/pharos-null-store" },
      signer: new NullSigner("signing"),
      resolveKeyName: (t) => `tenant:${t}`,
      notifier: {},
    });
    expect(built.posture.worm).toBe(false);
  });

  it("names the registered backends when the configured one does not exist", async () => {
    await expect(
      createStorageBackend("no-such-store", {
        settings: {},
        signer: new NullSigner("signing"),
        resolveKeyName: (t) => `tenant:${t}`,
        notifier: {},
      }),
    ).rejects.toThrow(/unknown storage backend "no-such-store"; registered: .*embedded.*postgres/);
  });

  it("rejects backend names that could not be selected from the environment", () => {
    expect(() => registerStorageBackend("Not Kebab", async () => ({}) as StorageBackend)).toThrow(
      /kebab-case/,
    );
    expect(() => config({ PHAROS_STORAGE_BACKEND: "Not Kebab" })).toThrow(/kebab-case/);
  });

  it("the shipped backends refuse to build without the settings they need", async () => {
    const ctx = {
      signer: new NullSigner("signing"),
      resolveKeyName: (t: string) => `tenant:${t}`,
      notifier: {},
    };
    await expect(createStorageBackend("postgres", { settings: {}, ...ctx })).rejects.toThrow(
      /requires PHAROS_PG_URL/,
    );
    await expect(createStorageBackend("embedded", { settings: {}, ...ctx })).rejects.toThrow(
      /requires a data directory/,
    );
  });
});

describe("signing-provider registry", () => {
  it("ships local-kms and aws-kms and resolves them by configuration", () => {
    expect(listSigningProviders()).toEqual(expect.arrayContaining(["aws-kms", "local-kms"]));
    const signer = buildSigner(config({ PHAROS_KMS_PROVIDER: "local-kms" }));
    expect(signer.providerId).toBe("local-kms");
  });

  it("a new backend is one register call away from the composition root", () => {
    expect(hasSigningProvider("null-hsm")).toBe(false);
    registerSigningProvider("null-hsm", ({ namespace }) => new NullSigner(namespace));

    const signer = buildSigner(config({ PHAROS_KMS_PROVIDER: "null-hsm" }));
    expect(signer.providerId).toBe("null-hsm");
    expect((signer as NullSigner).namespace).toBe("signing");

    // The local TSA signs with the same backend in its own namespace.
    const { tsa } = buildTsaProvider(
      config({ PHAROS_KMS_PROVIDER: "null-hsm", PHAROS_TSA_PROVIDER: "local" }),
    );
    expect(tsa.kind).toBe("local");
  });

  it("names the registered backends when the configured one does not exist", () => {
    expect(() => buildSigner(config({ PHAROS_KMS_PROVIDER: "no-such-kms" }))).toThrow(
      /unknown signing provider "no-such-kms"; registered: .*aws-kms.*local-kms/,
    );
    expect(() =>
      createSigningProvider("no-such-kms", {
        settings: { keystoreDir: "x" },
        namespace: "signing",
      }),
    ).toThrow(/registered/);
  });

  it("rejects provider names that could not be selected from the environment", () => {
    expect(() => registerSigningProvider("Not Kebab", () => new NullSigner("signing"))).toThrow(
      /kebab-case/,
    );
  });
});

describe("TSA-provider registry", () => {
  it("ships local and rfc3161", () => {
    expect(listTsaProviders()).toEqual(expect.arrayContaining(["local", "rfc3161"]));
  });

  it("a new trusted-time backend registers without touching the composition root", async () => {
    const stub: TsaProvider = {
      kind: "rfc3161",
      timestamp: async (hash) => ({ hash, time: "2026-01-01T00:00:00.000Z", provider: "stub" }),
    };
    registerTsaProvider("stub-tsa", () => ({ tsa: stub, keyset: async () => [] }));

    const built = buildTsaProvider(config({ PHAROS_TSA_PROVIDER: "stub-tsa" }));
    expect(await built.tsa.timestamp("abc")).toMatchObject({ hash: "abc", provider: "stub" });
    expect(await built.keyset()).toEqual([]);

    expect(() =>
      createTsaProvider("nope", {
        settings: { trustedCertSha256: [], intervalMs: 0 },
        env: "local",
        localSigner: () => new NullSigner("tsa"),
      }),
    ).toThrow(/unknown TSA provider "nope"/);
  });
});

describe("judge-provider registry", () => {
  it("ships linear and onnx, and takes the required concerns from the model manifest", () => {
    expect(listJudgeProviders()).toEqual(expect.arrayContaining(["linear", "onnx"]));
    expect(PRODUCTION_JUDGE_CONCERNS).toEqual(servedConcerns());
    expect(PRODUCTION_JUDGE_CONCERNS).toEqual([
      "finra-promissory",
      "funds-movement-intent",
      "phi-in-context",
    ]);
  });

  it("a new serving backend registers and is selected by configuration", async () => {
    const seen: string[][] = [];
    registerJudgeProvider("recording", async ({ concerns }) => {
      seen.push([...concerns]);
      return new ModelRegistry();
    });
    const registry = await buildJudgeRegistry(config({ PHAROS_JUDGE_PROVIDER: "recording" }));
    expect(registry).toBeInstanceOf(ModelRegistry);
    expect(seen).toEqual([[...PRODUCTION_JUDGE_CONCERNS]]);

    await expect(createJudgeRegistry("nope", { concerns: [] })).rejects.toThrow(
      /unknown judge provider "nope"/,
    );
  });
});

describe("policy packs and judge bindings are discovered, not listed", () => {
  it("the cascade's default bindings are exactly the shipped packs' bindings", () => {
    expect(DEFAULT_PACK_BINDINGS).toEqual(judgeBindingsOf(SHIPPED_PACKS));
    expect(DEFAULT_PACK_BINDINGS.map((b) => b.packId).sort()).toEqual([
      ...PRODUCTION_JUDGE_CONCERNS,
    ]);
  });

  it("a new pack file adds a pack and a concern binding with no code change", () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-packs-"));
    writeFileSync(
      join(dir, "sox.json"),
      JSON.stringify({
        packId: "sox",
        version: "1.0.0",
        title: "SOX 404 change control",
        rules: [
          {
            ruleId: "sox-404-unreviewed-change",
            pack: "sox",
            clause: "SOX §404 / COSO change management",
            description:
              "A production change without a reviewed ticket is escalated to the control owner.",
            when: { all: [{ field: "action.type", op: "startsWith", value: "deploy." }] },
            decision: "escalate",
          },
        ],
        judgeBindings: [
          {
            packId: "change-intent",
            actionTypes: ["deploy."],
            onFlag: "escalate",
            citation: { ruleId: "sox-404-unreviewed-change", pack: "sox", clause: "SOX §404" },
          },
        ],
      }),
    );
    const packs = loadShippedPacks(dir);
    expect(Object.keys(packs)).toEqual(["sox"]);
    expect(judgeBindingsOf(packs)).toEqual([
      expect.objectContaining({ packId: "change-intent", onFlag: "escalate" }),
    ]);
  });
});
