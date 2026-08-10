import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@pharos/config";
import type { AsyncJudge, JudgeResult } from "@pharos/judge";
import {
  buildJudgeRegistry,
  PRODUCTION_JUDGE_CONCERNS,
  type JudgeLoader,
} from "../services/api/src/platform.js";

function config(provider: "linear" | "onnx") {
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
    PHAROS_JUDGE_PROVIDER: provider,
    PHAROS_JUDGE_MODEL_DIR: "/approved/model-cache",
  });
}

function fakeJudge(concern: string): AsyncJudge {
  return {
    packId: concern,
    concern,
    version: () => `${concern}@verified`,
    scoreBatch: async (texts: string[]): Promise<JudgeResult[]> =>
      texts.map(() => ({
        packId: concern,
        concern,
        judgeVersion: `${concern}@verified`,
        probability: 0.75,
        flagged: true,
        threshold: 0.5,
      })),
  };
}

describe("production judge composition", () => {
  it("preloads every required ONNX concern from the configured cache", async () => {
    const loader = vi.fn<JudgeLoader>(async ({ concern }) => fakeJudge(concern));
    const registry = await buildJudgeRegistry(config("onnx"), loader);

    expect(loader).toHaveBeenCalledTimes(PRODUCTION_JUDGE_CONCERNS.length);
    for (const concern of PRODUCTION_JUDGE_CONCERNS) {
      expect(loader).toHaveBeenCalledWith({
        concern,
        packId: concern,
        cacheDir: "/approved/model-cache",
      });
      expect(registry.activeVersion(concern)).toBe(`${concern}@verified`);
      expect((await registry.judgeAsync(concern, "test")).judgeVersion).toBe(`${concern}@verified`);
    }
  });

  it("fails startup instead of serving a partial judge fleet", async () => {
    const loader: JudgeLoader = async ({ concern }) => {
      if (concern === "phi-in-context") throw new Error("digest mismatch");
      return fakeJudge(concern);
    };
    await expect(buildJudgeRegistry(config("onnx"), loader)).rejects.toThrow("digest mismatch");
  });

  it("loads all required judges concurrently without exposing a partial registry", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const loader = vi.fn<JudgeLoader>(async ({ concern }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return fakeJudge(concern);
    });

    const building = buildJudgeRegistry(config("onnx"), loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(PRODUCTION_JUDGE_CONCERNS.length));
    expect(peak).toBe(PRODUCTION_JUDGE_CONCERNS.length);
    for (const release of releases) release();

    const registry = await building;
    for (const concern of PRODUCTION_JUDGE_CONCERNS) {
      expect(registry.activeVersion(concern)).toBe(`${concern}@verified`);
    }
  });

  it("warms every inference session before returning the registry", async () => {
    const warm = vi.fn(async (texts: string[]): Promise<JudgeResult[]> =>
      texts.map(() => ({
        packId: "warm",
        concern: "warm",
        judgeVersion: "warm@verified",
        probability: 0,
        flagged: false,
        threshold: 0.5,
      })),
    );
    const loader: JudgeLoader = async ({ concern }) => ({
      ...fakeJudge(concern),
      scoreBatch: warm,
    });

    await buildJudgeRegistry(config("onnx"), loader);
    expect(warm).toHaveBeenCalledTimes(PRODUCTION_JUDGE_CONCERNS.length);
    expect(warm).toHaveBeenCalledWith([""]);
  });

  it("rejects a loader that returns the wrong concern identity", async () => {
    const loader: JudgeLoader = async () => fakeJudge("wrong-concern");
    await expect(buildJudgeRegistry(config("onnx"), loader)).rejects.toThrow(
      "for required concern finra-promissory",
    );
  });

  it("keeps the explicit linear baseline available outside production", async () => {
    const loader = vi.fn<JudgeLoader>();
    const registry = await buildJudgeRegistry(config("linear"), loader);
    expect(loader).not.toHaveBeenCalled();
    expect(registry.activeVersion("finra-promissory")).toMatch(/^finra-promissory@[a-f0-9]{12}$/);
  });
});
