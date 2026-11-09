import type { ModelManifest } from "./artifactStore.js";
// A static JSON import (not a runtime readFileSync of ../package.json) so a bundler such as
// the CLI's esbuild build inlines the pin instead of resolving a path that no longer exists.
import PACKAGE_JSON from "../package.json" with { type: "json" };

const ORT_VERSION = PACKAGE_JSON.dependencies?.["onnxruntime-node"];
if (!ORT_VERSION || !/^\d+\.\d+\.\d+$/.test(ORT_VERSION)) {
  throw new Error("@pharos/judge must pin onnxruntime-node to an exact semantic version");
}

/** Identity of the native inference implementation that can affect replay output. */
export function onnxRuntimeIdentity(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `onnxruntime-node@${ORT_VERSION}/${platform}-${arch}`;
}

/** Refuse production serving on a runtime/platform that has not passed parity qualification. */
export function assertQualifiedOnnxRuntime(
  manifest: ModelManifest,
  identity: string = onnxRuntimeIdentity(),
): void {
  if (!manifest.qualifiedRuntimes?.includes(identity)) {
    throw new Error(
      `ONNX runtime ${identity} is not production-qualified; approved: ${manifest.qualifiedRuntimes?.join(", ") || "none"}`,
    );
  }
}
