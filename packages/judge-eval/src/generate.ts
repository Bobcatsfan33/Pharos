import { sha256Hex } from "@pharos/core";
import {
  type ConcernManifest,
  type EvalExample,
  type EvalSplit,
  type Lang,
  type Suite,
  EVAL_SCHEMA_VERSION,
  splitContentHash,
} from "./schema.js";
import { CONCERN_SPECS, type ConcernSpec, type Template } from "./concerns/index.js";
import { mulberry32, pick } from "./prng.js";
import { TRANSFORMS, type TransformName } from "./transforms.js";

const CLEAN_TARGET = 300; // ≥300 clean positives and ≥300 clean negatives (roadmap S5-T1)
const ADVERSARIAL_TARGET = 80; // obfuscated positives per adversarial suite
const NATIVE_TARGET = 60; // per native-language suite (mixed labels)

function fill(text: string, slots: Record<string, string[]>, rng: () => number): string {
  return text.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const values = slots[key];
    if (!values) throw new Error(`Unknown slot {${key}} in template`);
    return pick(values, rng);
  });
}

/** Expand templates by deterministic slot-filling into `target` DISTINCT texts (or as many as the
 *  slot space allows). Round-robins templates so every template contributes. */
function expand(
  templates: Template[],
  slots: Record<string, string[]>,
  target: number,
  rng: () => number,
): Array<{ text: string; template: Template }> {
  const out: Array<{ text: string; template: Template }> = [];
  const seen = new Set<string>();
  const maxAttempts = target * 200 + 1000;
  let attempts = 0;
  while (out.length < target && attempts < maxAttempts) {
    const template = templates[attempts % templates.length]!;
    const text = fill(template.text, slots, rng);
    attempts++;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, template });
  }
  return out;
}

function toExample(
  concern: ConcernSpec["concern"],
  suite: Suite,
  lang: Lang,
  index: number,
  text: string,
  template: Template,
): EvalExample {
  return {
    id: `${concern}/${suite}/${lang}/${index}`,
    concern,
    suite,
    lang,
    label: template.label,
    hardNegative: template.hardNegative ?? false,
    ...(template.nearMissClass ? { nearMissClass: template.nearMissClass } : {}),
    text,
    templateId: template.id,
    source: template.source,
  };
}

function makeSplit(
  concern: ConcernSpec["concern"],
  suite: Suite,
  lang: Lang,
  examples: EvalExample[],
): EvalSplit {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    concern,
    suite,
    lang,
    count: examples.length,
    positives: examples.filter((e) => e.label === 1).length,
    hardNegatives: examples.filter((e) => e.hardNegative).length,
    examples,
  };
}

/** Generate every split for one concern, deterministically from `seed`. */
export function generateConcern(
  concern: ConcernSpec["concern"],
  seed: number,
  generatedAt: string,
): { splits: EvalSplit[]; manifest: ConcernManifest } {
  const spec = CONCERN_SPECS[concern];
  const rng = mulberry32(seed);
  const splits: EvalSplit[] = [];

  // --- Clean positives ---
  const posRaw = expand(spec.positives, spec.slots, CLEAN_TARGET, rng);
  const cleanPositive = makeSplit(
    concern,
    "clean-positive",
    "en",
    posRaw.map((r, i) => toExample(concern, "clean-positive", "en", i, r.text, r.template)),
  );
  splits.push(cleanPositive);

  // --- Clean negatives: hard-negatives dominate (≥60%); easy fills the remainder ---
  const easyCap = Math.floor(CLEAN_TARGET * 0.4);
  const easyRaw = expand(spec.easyNegatives, spec.slots, easyCap, rng);
  const hardNeeded = CLEAN_TARGET - easyRaw.length;
  const hardRaw = expand(spec.hardNegatives, spec.slots, hardNeeded, rng);
  const negRaw = [...hardRaw, ...easyRaw];
  const cleanNegative = makeSplit(
    concern,
    "clean-negative",
    "en",
    negRaw.map((r, i) => toExample(concern, "clean-negative", "en", i, r.text, r.template)),
  );
  splits.push(cleanNegative);

  // --- Adversarial suites: obfuscated positives (recall degradation vs clean) ---
  const seeds = cleanPositive.examples.slice(0, ADVERSARIAL_TARGET);
  const transforms: TransformName[] = [
    "paraphrase",
    "synonym",
    "leetspeak",
    "base64",
    "rot13",
    "sentence-split",
    "prompt-injection",
  ];
  for (const t of transforms) {
    const examples = seeds.map((seed_, i) =>
      toExample(
        concern,
        t as Suite,
        "en",
        i,
        TRANSFORMS[t](seed_.text),
        // preserve the source template's label(=1) + provenance
        { id: seed_.templateId, label: 1, source: seed_.source, text: "" },
      ),
    );
    splits.push(makeSplit(concern, t as Suite, "en", examples));
  }

  // --- Native ES / DE suites (mixed labels; NOT machine-translated) ---
  for (const [lang, suite] of [
    ["es", "spanish"],
    ["de", "german"],
  ] as const) {
    const raw = expand(spec.native[lang], spec.slots, NATIVE_TARGET, rng);
    const examples = raw.map((r, i) => toExample(concern, suite, lang, i, r.text, r.template));
    splits.push(makeSplit(concern, suite, lang, examples));
  }

  // --- Manifest ---
  const splitEntries = splits.map((s) => ({
    suite: s.suite,
    lang: s.lang,
    file: `${s.suite}.${s.lang}.json`,
    count: s.count,
    positives: s.positives,
    hardNegatives: s.hardNegatives,
    contentHash: splitContentHash(s),
  }));
  const manifest: ConcernManifest = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    concern,
    seed,
    generator: {
      kind: "template-expansion",
      author: "Pharos engineering (S5-T1)",
      generatedAt,
      note: "Deterministic template + slot expansion; labels are template properties grounded in cited authority (see sources), not model-inferred. Committed JSON + hashes are authoritative (§7-10(f)); regeneration is deterministic given this seed but is provenance, not a bit-identical promise.",
    },
    sources: spec.sources,
    taxonomy: spec.taxonomy,
    splits: splitEntries,
    humanReview: {
      status: "pending-qualified-review",
      reviewer: null,
      qualification: null,
      reviewedAt: null,
      sampleMethod:
        "Deterministic stratified 10% sample across concern×label×suite×language, selected by seeded index (see scripts/sample-review.ts).",
      fractionReviewed: 0,
      corrections: 0,
      agreementRate: null,
      notes:
        "Engineer authored templates from cited regulatory sources; qualified compliance-literate review is an outstanding human gate (§7-10(a)).",
    },
    datasetHash: sha256Hex(splitEntries.map((e) => e.contentHash)),
  };

  return { splits, manifest };
}
