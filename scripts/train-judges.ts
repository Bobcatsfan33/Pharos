/**
 * Train the Tier-3 distilled judge models and write versioned artifacts.
 *
 *   pnpm judges:train
 *
 * Training is deterministic (full-batch gradient descent, zero init), so re-running
 * produces byte-identical artifacts and the same model versions. Artifacts are committed
 * under packages/judge/models/ and loaded by the registry at runtime.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { trainJudge, modelVersion } from "../packages/judge/src/index.js";
import { FINRA_PROMISSORY } from "../packages/judge/data/finra-promissory.js";
import { PHI_IN_CONTEXT } from "../packages/judge/data/phi-in-context.js";
import { FUNDS_MOVEMENT_INTENT } from "../packages/judge/data/funds-movement-intent.js";

const here = dirname(fileURLToPath(import.meta.url));
const modelsDir = join(here, "..", "packages", "judge", "models");
mkdirSync(modelsDir, { recursive: true });

const packs = [
  { packId: "finra-promissory", concern: "FINRA 2210 promissory / guaranteed-return language", data: FINRA_PROMISSORY, threshold: 0.5 },
  { packId: "phi-in-context", concern: "PHI present in message context", data: PHI_IN_CONTEXT, threshold: 0.5 },
  { packId: "funds-movement-intent", concern: "Intent to move funds", data: FUNDS_MOVEMENT_INTENT, threshold: 0.5 },
];

let trainAcc = 0;
let trainN = 0;
for (const pack of packs) {
  const artifact = trainJudge(pack.data, {
    packId: pack.packId,
    concern: pack.concern,
    threshold: pack.threshold,
  });
  const version = modelVersion(artifact);

  // Report training accuracy as a basic sanity gate.
  const { score } = await import("../packages/judge/src/model.js");
  let correct = 0;
  for (const ex of pack.data) {
    const p = score(artifact, ex.text);
    if ((p >= pack.threshold ? 1 : 0) === ex.label) correct++;
  }
  const acc = correct / pack.data.length;
  trainAcc += correct;
  trainN += pack.data.length;

  const file = join(modelsDir, `${pack.packId}.model.json`);
  writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`${pack.packId.padEnd(24)} ${version}  train-acc ${(acc * 100).toFixed(1)}%  (${Object.keys(artifact.weights).length} features)`);
}
console.log(`\nOverall train accuracy: ${((trainAcc / trainN) * 100).toFixed(1)}% over ${trainN} examples.`);
