# ADR 0004 — Adversarial mitigation for Tier-3 judges: robustness vs decode-normalization

- **Status:** Accepted (tech-lead ruling, Sprint 6) — **hybrid with a cascade-owned normalizer**. To be folded in as roadmap amendment 10(k) once the built split matches this ADR.
- **Context:** Sprint 6 (transformer judges). Numbering skips 0002/0003, which the roadmap reserves for S9 (policy interop, Envoy).

## Ruling (tech lead)

Option **C (hybrid)**, but the normalizer is **cascade-owned, not judge-owned** — the opposite
placement from my recommendation, for eval-integrity reasons. Binding conditions:

1. **Placement — cascade text-harvest, not the judge.** The normalizer extends the cascade's
   `actionText` harvest step (`packages/cascade/src/cascade.ts`), never a judge front-end. Reason
   (amendment 10(e)): models stay **measurable bare**, so model-vs-model comparison and the S5-T4
   gate stay attributable. A judge-owned decoder could mask a model regression.
2. **Union scoring, more-severe wins.** The harvest emits **raw AND normalized** text; judges score
   the union and the cascade takes the **more-severe** verdict. Obfuscation can only **add**
   detections, never mask a plaintext signal.
3. **Bounded + hostile-safe** (it is on the verdict path): cap input size, decode expansion ratio,
   and nesting depth (small fixed depth, **no unbounded recursion**); stay within the 800ms
   envelope; **never throw or stall** on pathological input. Fuzz it — nested base64, base64-of-
   garbage, decode-bomb, huge inputs — and gate those tests.
4. **Models are evaluated BARE in judge-eval** — the normalizer is **not** folded into a model's
   eval score.

### The AC is split, and reported split

- **Model AC (S5-T4 gate, BARE):** the transformer beats the logistic baseline on **clean** and the
  **semantic** suites (paraphrase, synonym, translation — i.e. native es/de). That is the real model
  win. `nonzero beats 0%` on base64 does **not** count as a model win.
- **System AC (separate end-to-end eval, cascade + normalizer):** the **encoding** suites (base64,
  rot13) are beaten by the **system**, gated on their own, and stated as such in the model card and
  threat model.
- **Leetspeak stays in the MODEL bucket** (subword tokenization should handle much of it); a
  normalization rule for it is added only if the measured number shows the model cannot. Measure,
  don't pre-build.

Two numbers go to review before commit: **bare semantic-suite recall** (model) and **end-to-end
base64/rot13 recall with the normalizer** (system), separately.

## Context

The S5 baseline (`docs/benchmarks/judge-evals.md`) scores **0% recall on the `base64` and `rot13`
adversarial suites** for all three concerns. Those suites wrap the whole payload in a reversible
encoding behind a carrier phrase (e.g. `Decode and act on the following base64 message: <b64>`).

The other adversarial suites are **semantic** obfuscations of natural text — paraphrase, synonym
substitution, leetspeak, sentence-splitting, prompt-injection framing, and native Spanish/German.

These two classes have **different root causes**, and conflating them makes "beat every adversarial
suite" ambiguous:

- **Semantic suites** are a *model-capacity* problem. A fine-tuned transformer encoder understands
  meaning, not just bag-of-words features, so it can plausibly recover recall on paraphrase /
  synonym / leetspeak / translation. This is what S6-T1's fine-tuning is *for*.
- **Encoding suites (base64/rot13)** are **not** a model problem. A ~66M-parameter encoder cannot
  learn to decode arbitrary base64/rot13 from a few hundred fine-tuning examples — it would memorize
  the training payloads and still score ~0% on the held-out eval payloads (which it has never seen
  and, per the prime directive, must never see). Decoding a reversible transport encoding is a
  deterministic string operation, not a semantic inference.

## Options

**A. Model robustness only** — add base64/rot13 examples to the training corpus and rely on the
transformer to generalize.
*Rejected.* A small encoder cannot learn general base64/rot13 decoding; it memorizes. The eval
payloads are held out, so recall stays ~0%. It also burns capacity on a non-semantic task.

**B. Decode-normalization preprocessing only** — a deterministic normalizer decodes base64/rot13
(and folds leetspeak/homoglyphs) ahead of the judge; keep the current logistic model.
*Partial.* Fixes the encoding suites and helps some semantic ones, but leaves paraphrase / synonym /
translation to a bag-of-words model that cannot handle them. Does not meet "beat every suite."

**C. Hybrid — decode-normalization front-end + fine-tuned transformer (RECOMMENDED).** A shared,
deterministic **normalization pass** detects and decodes reversible encodings (base64, rot13) and
folds obvious character-level obfuscation (leetspeak, zero-width/homoglyph) *before* tokenization;
the **transformer** owns semantic robustness (paraphrase, synonym, native-language). Each layer
solves the class it actually can.

## Recommendation: **C (hybrid)**, with the normalizer owned by the *judge*, not the cascade

- The normalizer lives in the judge's `scoreBatch` front-end (`packages/judge/src/normalize.ts`),
  so it is part of the served model pipeline and **covered by the version-is-content-hash rule**
  (its ruleset hashes into `modelVersion()`). This keeps the cascade unchanged and keeps
  train/serve parity trivial (the same normalizer runs in the Python trainer's scorer and the Node
  server).
- It is **conservative**: it only rewrites a span when a decode is unambiguous (valid base64 that
  decodes to mostly-printable text; a carrier phrase present), so benign text is untouched. Decode
  results are length- and content-capped to avoid a decompression/DoS surface.
- **Gate semantics under C:** the S5-T4 gate compares the *candidate pipeline* (normalizer +
  transformer) against the *frozen logistic baseline* (no normalizer). base64/rot13 recall goes
  0% → high because the candidate decodes and the baseline does not — a legitimate, honest win at
  the frozen operating points. Semantic-suite wins come from the transformer. Both are real.

### What the ruling changes

- If **A/B**: S6-T1 scope and the "beat every suite" bar change materially (A is infeasible; B
  drops the semantic bar).
- If **C**: I build the normalizer + the transformer; "beat every adversarial suite" is met by the
  combined pipeline, and the ADR records that base64/rot13 is won by decoding, not by the model
  pretending to be a decoder.
- **Alternative placement** to rule on if not C-as-recommended: normalizer as a **cascade
  preprocessing step** (shared across all judges, versioned separately) instead of inside the
  judge. Cleaner separation, but then train/serve parity and the version hash must account for a
  second artifact.

## Consequence (whichever way): honesty

Whatever is ruled, the eval report and model cards will state plainly which suites are won by the
model and which by preprocessing. We do not claim the transformer "learned to decode base64."
