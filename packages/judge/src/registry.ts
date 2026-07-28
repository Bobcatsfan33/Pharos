import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type JudgeModelArtifact,
  type JudgeResult,
  judge as judgeWith,
  modelVersion,
} from "./model.js";
import { type AsyncJudge } from "./onnxModel.js";

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
