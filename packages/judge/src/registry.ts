import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type JudgeModelArtifact,
  type JudgeResult,
  judge as judgeWith,
  modelVersion,
} from "./model.js";
import { type AsyncJudge, type LoadOnnxOptions, loadOnnxJudge } from "./onnxModel.js";
import { loadManifest } from "./artifactStore.js";

/** The directory of committed, trained model artifacts shipped with the package. */
export const DEFAULT_MODELS_DIR = fileURLToPath(new URL("../models", import.meta.url));

/**
 * The model registry: versioned judge models served per domain pack.
 *
 * Every verdict that reaches Tier 3 cites the exact judge version it used. The registry
 * holds one active model per pack plus all historical versions, so a past verdict can be
 * replayed against the precise model that produced it.
 */
export class ModelRegistry {
  private active = new Map<string, JudgeModelArtifact>();
  private byVersion = new Map<string, JudgeModelArtifact>();
  // Served async judges (e.g. ONNX transformers). The registry is polymorphic on artifact kind:
  // a pack is served by a logistic artifact OR an async judge; the version-is-content-hash rule is
  // unchanged (a served judge reports its manifest modelVersion).
  private served = new Map<string, AsyncJudge>();
  private servedByVersion = new Map<string, AsyncJudge>();

  register(artifact: JudgeModelArtifact): string {
    const version = modelVersion(artifact);
    this.active.set(artifact.packId, artifact);
    this.byVersion.set(version, artifact);
    return version;
  }

  /** Register a served async judge (ONNX transformer) alongside the logistic artifacts. */
  registerServed(judge: AsyncJudge): string {
    const version = judge.version();
    this.served.set(judge.packId, judge);
    this.servedByVersion.set(version, judge);
    return version;
  }

  has(packId: string): boolean {
    return this.active.has(packId) || this.served.has(packId);
  }

  get(packId: string): JudgeModelArtifact | undefined {
    return this.active.get(packId);
  }

  getByVersion(version: string): JudgeModelArtifact | undefined {
    return this.byVersion.get(version);
  }

  activeVersion(packId: string): string | undefined {
    const served = this.served.get(packId);
    if (served) return served.version();
    const a = this.active.get(packId);
    return a ? modelVersion(a) : undefined;
  }

  listVersions(): Array<{ packId: string; concern: string; version: string }> {
    const logistic = [...this.byVersion.entries()].map(([version, a]) => ({
      packId: a.packId,
      concern: a.concern,
      version,
    }));
    const served = [...this.servedByVersion.values()].map((j) => ({
      packId: j.packId,
      concern: j.concern,
      version: j.version(),
    }));
    return [...logistic, ...served];
  }

  /** Judge text with a pack's active LOGISTIC model (synchronous). Throws for served async judges —
   *  callers that must support both kinds use `judgeAsync`. */
  judge(packId: string, text: string): JudgeResult {
    const artifact = this.active.get(packId);
    if (!artifact) throw new Error(`No logistic judge registered for pack: ${packId}`);
    return judgeWith(artifact, text);
  }

  /** Judge text with a pack's active model, dispatching on kind (served async judge preferred). */
  async judgeAsync(packId: string, text: string): Promise<JudgeResult> {
    const served = this.served.get(packId);
    if (served) return (await served.scoreBatch([text]))[0]!;
    const artifact = this.active.get(packId);
    if (!artifact) throw new Error(`No judge model registered for pack: ${packId}`);
    return judgeWith(artifact, text);
  }

  /** Judge text with a specific historical model version (for replay). */
  judgeWithVersion(version: string, text: string): JudgeResult {
    const artifact = this.byVersion.get(version);
    if (!artifact) throw new Error(`No judge model for version: ${version}`);
    return judgeWith(artifact, text);
  }
}

/** Load the registry from the package's committed model artifacts. */
export function loadDefaultRegistry(): ModelRegistry {
  return loadRegistryFromDir(DEFAULT_MODELS_DIR);
}

/** Load all *.model.json artifacts from a directory into a new registry. */
export function loadRegistryFromDir(dir: string): ModelRegistry {
  const registry = new ModelRegistry();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".model.json")) continue;
    const artifact = JSON.parse(readFileSync(join(dir, file), "utf8")) as JudgeModelArtifact;
    registry.register(artifact);
  }
  return registry;
}

// ---------------------------------------------------------------------------------------------
// Judge-provider registry
//
// The composition root selects how Tier-3 judges are served by name (`PHAROS_JUDGE_PROVIDER`)
// and asks this registry to build the `ModelRegistry`. Adding a serving backend is one file
// plus one `registerJudgeProvider` call. The set of concerns a deployment must serve is read
// from `models/manifest.json`, the single list of served judge models.
// ---------------------------------------------------------------------------------------------

/** Loads one served judge for a concern; `loadOnnxJudge` in production, a fake in tests. */
export type JudgeLoader = (options: LoadOnnxOptions) => Promise<AsyncJudge>;

export interface JudgeProviderContext {
  /** Every concern the registry must serve; startup is all-or-nothing over this list. */
  concerns: readonly string[];
  /** Content-addressed model cache (pre-staged for restricted networks). */
  cacheDir?: string | undefined;
  /** Override the per-concern loader (startup tests inject fakes). */
  loadJudge?: JudgeLoader | undefined;
}

export type JudgeProviderFactory = (ctx: JudgeProviderContext) => Promise<ModelRegistry>;

const providers = new Map<string, JudgeProviderFactory>();

/** Register a judge-serving backend under the name `PHAROS_JUDGE_PROVIDER` selects it by. */
export function registerJudgeProvider(name: string, factory: JudgeProviderFactory): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`judge provider name must be lower-case kebab-case, got "${name}"`);
  }
  providers.set(name, factory);
}

/** Build the registry with the named backend, or throw naming the backends registered. */
export function createJudgeRegistry(
  name: string,
  ctx: JudgeProviderContext,
): Promise<ModelRegistry> {
  const factory = providers.get(name);
  if (!factory) {
    return Promise.reject(
      new Error(`unknown judge provider "${name}"; registered: ${listJudgeProviders().join(", ")}`),
    );
  }
  return factory(ctx);
}

export function hasJudgeProvider(name: string): boolean {
  return providers.has(name);
}

export function listJudgeProviders(): string[] {
  return [...providers.keys()].sort();
}

/** The concerns with a served model in the manifest — what a production deployment must load. */
export function servedConcerns(manifest = loadManifest()): string[] {
  return Object.keys(manifest.models).sort();
}

/** The measured linear baseline: logistic artifacts committed next to the manifest. */
registerJudgeProvider("linear", async () => loadDefaultRegistry());

/**
 * Served transformer judges. Every concern's artifact is fetched or read, digest-verified
 * against the manifest, given an inference session and warmed before anything is
 * registered: a partial fleet is a startup failure, never a silent fallback.
 */
registerJudgeProvider("onnx", async ({ concerns, cacheDir, loadJudge = loadOnnxJudge }) => {
  const judges = await Promise.all(
    concerns.map(async (concern) => {
      const judge = await loadJudge({ concern, packId: concern, cacheDir });
      // Exercise the actual inference path before the readiness listener can open.
      await judge.scoreBatch([""]);
      return judge;
    }),
  );
  const registry = new ModelRegistry();
  for (const [index, concern] of concerns.entries()) {
    const judge = judges[index]!;
    if (judge.packId !== concern || judge.concern !== concern) {
      throw new Error(
        `judge loader returned ${judge.packId}/${judge.concern} for required concern ${concern}`,
      );
    }
    registry.registerServed(judge);
  }
  return registry;
});
