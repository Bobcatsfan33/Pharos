/**
 * Generate the LOCKBOX test set (tech-lead ruling / amendment 10(l)).
 *
 *   pnpm --filter @pharos/judge-eval exec tsx scripts/gen-lockbox.ts
 *
 * Same generator + taxonomy as the dev eval set, but a NEW seed (fresh instances never observed by
 * the recipe) and HARDENED base64/rot13 carriers (tests decoding, not carrier anomaly). The lockbox
 * is the source of the Sprint-6 numbers of RECORD; the committed dev eval set is now only a dev set.
 * Written flattened for the training-side scorer; it must NEVER be used for training or tuning.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CONCERNS } from "../src/schema.js";
import { generateConcern } from "../src/generate.js";
import { splitContentHash } from "../src/schema.js";

const OUT = fileURLToPath(new URL("../../../training/lockbox", import.meta.url));
// Distinct from the dev seeds in scripts/generate.ts — fresh, unobserved instances.
const SEEDS: Record<string, number> = {
  "finra-promissory": 0xbeef01,
  "phi-in-context": 0xbeef02,
  // Drawn after the speech-act-meta-frame-v2 recipe was frozen in commit 93fff3d. This is the
  // one-shot issue-#91 qualification lockbox; do not tune or retrain against its results.
  "funds-movement-intent": 0xe9f9a58b,
};

mkdirSync(OUT, { recursive: true });
for (const concern of CONCERNS) {
  const { splits } = generateConcern(concern, SEEDS[concern]!, "2026-07-26T00:00:00.000Z", {
    hardenedEncoding: true,
  });
  const flat = {
    concern,
    seed: SEEDS[concern],
    hardenedEncoding: true,
    splits: splits.map((s) => ({
      suite: s.suite,
      lang: s.lang,
      count: s.count,
      contentHash: splitContentHash(s),
      examples: s.examples.map((e) => ({
        label: e.label,
        hardNegative: e.hardNegative,
        text: e.text,
      })),
    })),
  };
  writeFileSync(join(OUT, `${concern}.json`), JSON.stringify(flat, null, 2) + "\n");
  const pos = splits.find((s) => s.suite === "clean-positive")!;
  console.log(
    `${concern}: lockbox ${splits.reduce((n, s) => n + s.count, 0)} examples (clean +${pos.count})`,
  );
}
console.log(`Wrote lockbox to ${OUT}`);
