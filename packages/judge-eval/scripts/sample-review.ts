/**
 * Emit the deterministic stratified 10% human-review sample (roadmap §7-10(a)).
 *
 *   pnpm --filter @pharos/judge-eval exec tsx scripts/sample-review.ts > review-sample.tsv
 *
 * Stratifies across concern × label × suite × language and selects every 10th record by a
 * seeded stride within each stratum, so the sample is reproducible and covers every cell. The
 * output is what a compliance-literate reviewer annotates; their record goes into each concern
 * manifest's `humanReview` block. No personal data is present (the corpus is synthetic).
 */
import { CONCERNS } from "../src/schema.js";
import { loadConcern } from "../src/loader.js";

const STRIDE = 10; // 10% sample

console.log(["concern", "suite", "lang", "label", "hardNegative", "id", "text"].join("\t"));
let total = 0;
let sampled = 0;
for (const concern of CONCERNS) {
  const { splits } = loadConcern(concern);
  for (const split of splits) {
    // Stratum = (concern, suite, lang, label): stride within the label-sorted stratum.
    for (const label of [0, 1] as const) {
      const stratum = split.examples.filter((e) => e.label === label);
      total += stratum.length;
      for (let i = 0; i < stratum.length; i += STRIDE) {
        const e = stratum[i]!;
        sampled++;
        console.log(
          [e.concern, e.suite, e.lang, e.label, e.hardNegative, e.id, JSON.stringify(e.text)].join(
            "\t",
          ),
        );
      }
    }
  }
}
console.error(`Sampled ${sampled} of ${total} records (${((sampled / total) * 100).toFixed(1)}%).`);
