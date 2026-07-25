/**
 * Regenerate the committed eval datasets + manifests.
 *
 *   pnpm --filter @pharos/judge-eval generate
 *
 * Deterministic given the per-concern seed. The committed JSON + hashes are the source of truth;
 * this script documents provenance and lets a reviewer reproduce-as-run. It does NOT run in CI —
 * CI validates the committed data (hashes + leakage), it does not regenerate it.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONCERNS } from "../src/schema.js";
import { generateConcern } from "../src/generate.js";
import { DATA_DIR } from "../src/loader.js";

// Fixed, committed generation date (provenance) — not wall-clock, to keep manifests stable.
const GENERATED_AT = process.env.GENERATED_AT ?? "2026-07-25T00:00:00.000Z";
// Per-concern deterministic seeds (distinct so concerns don't share a slot-fill sequence).
const SEEDS: Record<string, number> = {
  "finra-promissory": 0x5f1a2b,
  "phi-in-context": 0x9c3d4e,
  "funds-movement-intent": 0x7a6b5c,
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

for (const concern of CONCERNS) {
  const dir = join(DATA_DIR, concern);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const { splits, manifest } = generateConcern(concern, SEEDS[concern]!, GENERATED_AT);
  for (const split of splits) {
    writeJson(join(dir, `${split.suite}.${split.lang}.json`), split);
  }
  writeJson(join(dir, "manifest.json"), manifest);

  const total = splits.reduce((n, s) => n + s.count, 0);
  const pos = splits.find((s) => s.suite === "clean-positive")!;
  const neg = splits.find((s) => s.suite === "clean-negative")!;
  console.log(
    `${concern}: ${splits.length} splits, ${total} examples ` +
      `(clean +${pos.count}/-${neg.count}, hard-neg ${neg.hardNegatives}/${neg.count} = ${Math.round((neg.hardNegatives / neg.count) * 100)}%) ` +
      `datasetHash=${manifest.datasetHash.slice(0, 12)}`,
  );
}
console.log(`\nWrote datasets to ${DATA_DIR}`);
