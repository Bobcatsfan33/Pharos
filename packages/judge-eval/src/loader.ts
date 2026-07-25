import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConcernManifest,
  type Concern,
  type EvalExample,
  type EvalSplit,
  CONCERNS,
  splitContentHash,
} from "./schema.js";

/** The committed dataset directory (the source of truth). */
export const DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));

export interface LoadedConcern {
  manifest: ConcernManifest;
  splits: EvalSplit[];
}

function concernDir(concern: Concern): string {
  return join(DATA_DIR, concern);
}

/**
 * Load one concern's committed splits and manifest, verifying each split's content hash against
 * the manifest (§7-10(f): the committed data + hash is authoritative). Throws on mismatch.
 */
export function loadConcern(concern: Concern): LoadedConcern {
  const dir = concernDir(concern);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as ConcernManifest;
  const splits: EvalSplit[] = [];
  for (const entry of manifest.splits) {
    const split = JSON.parse(readFileSync(join(dir, entry.file), "utf8")) as EvalSplit;
    const hash = splitContentHash(split);
    if (hash !== entry.contentHash) {
      throw new Error(
        `Content hash mismatch for ${concern}/${entry.file}: manifest ${entry.contentHash} != computed ${hash}`,
      );
    }
    splits.push(split);
  }
  return { manifest, splits };
}

export function loadAllConcerns(): LoadedConcern[] {
  return CONCERNS.map(loadConcern);
}

/** All examples for a concern flattened (every split). */
export function allExamples(concern: Concern): EvalExample[] {
  return loadConcern(concern).splits.flatMap((s) => s.examples);
}

/** True when the committed data directory exists and is populated. */
export function datasetExists(): boolean {
  try {
    return readdirSync(DATA_DIR).length > 0;
  } catch {
    return false;
  }
}
