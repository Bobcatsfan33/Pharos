# judge-eval — dataset provenance & validity

This internal package is the **measuring stick** for the Tier-3 judges (roadmap Sprint 5). The
committed JSON under `data/<concern>/` plus each `manifest.json` content hash is the **source of
truth** (§7-10(f)); the generator is provenance, not a promise of bit-identical LLM regeneration.

> **Prime directive.** These examples must never be used to train, tune, or select a model. In
> Sprint 6, model developers may run the blinded harness and read aggregate reports, but may not
> open, search, copy, or tune against these records. Near-duplicate leakage into training data is
> the one unforgivable bug — enforced by the CI leakage gate (`test/judge-eval.leakage.test.ts`).

## What is here

Three concerns — `finra-promissory`, `phi-in-context`, `funds-movement-intent` — each with 11
splits: `clean-positive` (300), `clean-negative` (300, ≥60% hard negatives), seven English
adversarial suites (paraphrase, synonym, leetspeak, base64, rot13, sentence-split,
prompt-injection; 80 obfuscated positives each), and native `spanish` / `german` suites (60 each,
mixed labels). 1,280 examples per concern; 3,840 total.

## How ground truth is defensible (§7-10(a))

- **Labels are template properties, not model classifications.** Every example expands from a
  human-authored template (`src/concerns/*.ts`) whose label is fixed and grounded in a cited
  authority (`manifest.sources`): FINRA Rule 2210(d)(1)(A)/(B) for promissory language; HIPAA
  45 CFR §160.103 / §164.514(b) Safe Harbor for PHI; payment-operations executable-intent control
  framing (with SR 11-7 control language) for funds movement. An LLM is **not** the sole source of
  both an example and its accepted label.
- **Hard negatives dominate.** ≥60% of every negative split is a pre-taxonomized near miss
  (`manifest.taxonomy`), covering the near-miss classes an examiner would *not* flag (risk
  disclosures, historical returns with the required caveat, forward-looking "seeks/may", de-identified
  / synthetic / identifier-only / health-without-identifier, balance/conditional/cancelled/historical
  funds language). Measured hard-negative share: FINRA 90%, PHI 89%, funds 97%.
- **Native multilingual.** Spanish and German suites are natively authored (not machine-translated).
  *Human gate:* native-speaker review is outstanding (see Human review).
- **No sensitive data.** All health/financial examples are synthetic; no real individual, account,
  or restricted material is used.

## Generation

Deterministic template + slot expansion (`src/generate.ts`, seeded mulberry32 PRNG, no
`Math.random`). Regenerate with `pnpm --filter @pharos/judge-eval generate`. Per-concern seeds and
the fixed generation date are recorded in each `manifest.json` (`seed`, `generator.generatedAt`).

- **Generator identity:** Pharos engineering, template-expansion (no external LLM invoked in the
  committed pipeline; templates were human-authored from cited sources).
- **Shared-generator-family limitation:** because the eval text is engineer-authored English/native
  templates rather than LLM-sampled, it does not share a generator family with any later distilled
  model. If a future revision uses an LLM to widen variety, record its provider/model/version here
  and prefer a family different from the served model (§7-10(f)).

## Leakage protection (§7-10(d))

`src/dedup.ts` blocks normalized-exact matches **and** feature-aligned n-gram overlap against every
`packages/judge/data/` training record: token-bigram containment ≥ 0.80 or token-trigram Jaccard
≥ 0.50 (tokenization mirrors the judge featurizer). Current status: **0 exact, 0 n-gram hits** for
all three concerns; max bigram containment falls in the 0.2–0.4 bucket. The gate runs in CI
(`test/judge-eval.leakage.test.ts`) and is proven to fire on a seeded near-duplicate. A pinned
embedding review (cosine ≥ 0.92 → manual review) is the optional secondary defense and is not
required for the mandatory n-gram gate.

## Human review (outstanding gate)

`manifest.humanReview.status = "pending-qualified-review"`. A compliance-literate reviewer runs
`scripts/sample-review.ts` (deterministic stratified 10% across concern × label × suite × language),
annotates the sample, and records qualification, date, sample method, corrections, and agreement
rate back into each manifest. The generator author performed an engineering pre-review; the
qualified compliance review is a human gate the tech lead assigns.

## Reproducibility framing (§7-10(f))

The committed dataset + `datasetHash` are authoritative. `src/loader.ts` verifies every split's
content hash on load and throws on mismatch. Regeneration from the same seed is deterministic, but
that is provenance evidence, not the source of truth.
