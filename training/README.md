# Transformer judge training (Sprint 6, S6-T1)

Python/uv training pipeline for the CPU-servable transformer judges. **Out of the Node dependency
tree** — nothing here is imported by `packages/`. This directory produces model artifacts; it
**contains none** (they live in the external artifact store, fetched hash-verified against the
committed manifest — see `packages/judge/models/manifest.json`). `models/` and `.venv/` are
git-ignored.

## Prime directive (amendment 10)

Train/dev/test isolation is absolute. Training text comes only from `training/data/` (+ the small
seeds in `packages/judge/data/`) — **never** from `packages/judge-eval/`. `check_leakage.py` proves
zero n-gram overlap between the training corpus and the eval set before any run. The eval harness is
run **blinded** (metrics only; eval text is never printed or trained on).

**Three-way split (amendment 10(l)):**
- **train** — `training/data/*.jsonl` (this pipeline's corpus, disjoint surface forms from eval).
- **dev** — the committed `packages/judge-eval` set. The recipe was shaped against its *metrics*;
  it is now a dev set, not the final scorer.
- **lockbox** — `training/lockbox/*.json`: same generator + taxonomy, **new seed**, hardened
  base64/rot13 carriers, never observed by the recipe. **The Sprint-6 numbers of record come from
  the lockbox.** Regenerate with `pnpm --filter @pharos/judge-eval exec tsx scripts/gen-lockbox.ts`.

## Locked recipe

`distilbert-base-multilingual-cased` (135M) — multilingual because the "translation" semantic suite
(native es/de) cannot be beaten by an English-only encoder. Binary sequence classifier, 5 epochs,
lr 2e-5, batch 16, seed 42; temperature-scaling calibration on a held-out split; prompt-injection
augmentation with *varied* frames (a known threat class, not eval-specific). **Locked** — a recipe
revision is its own follow-up task (dev + fresh lockbox), not a mid-checkpoint patch.

Determinism: seeds fixed; CPU BLAS/threading may still cause last-bit logit drift across machines —
the committed `model.onnx` + its content hash are authoritative (same contract as the eval data).

## Commands

```bash
cd training && uv sync
uv run python corpus.py                       # generate the training corpus
uv run python check_leakage.py                # PROVE zero training↔eval leakage (blocks on any hit)
uv run python train.py --concern finra-promissory --epochs 5
uv run python quantize.py --concern finra-promissory     # dynamic int8 (served artifact)
uv run python calibrate.py --concern phi-in-context      # per-model int8 threshold (if int8 FPR regresses)
uv run python eval_final.py --concern finra-promissory   # numbers of record (dev vs lockbox, fp32 vs int8)
```

## Numbers of record (lockbox, served config, frozen threshold 0.5)

| concern | served | clean recall (logistic→model) | hard-neg FPR | semantic suites won |
|---|---|---|---|---|
| finra-promissory | int8 (129MB) | 57.7% → **97.7%** | 15.2% → **11.1%** | **7/7** |
| phi-in-context | fp32 (516MB) | 73.0% → **100%** | 41.0% → **16.0%** | 7/7 |
| funds-movement-intent | int8 (129MB) | 98.7% → **100%** | 82.5% → **33.2%** | 6/7 |

- **Batch-1 (serving-faithful) numbers of record** — dynamic int8 ONNX is **batch-sensitive** (the
  per-tensor activation scale spans the whole batch), so only single-inference matches the
  deterministic batch-1 serving path (`OnnxJudge.scoreBatch` runs batch-1 for reproducible verdicts).
  fp32 is batch-invariant. The earlier batch-32 eval was an artifact; the serving numbers are: finra
  int8 clean recall **97.0%** / hard-neg FPR 11.1%; funds int8 recall 100% / hard-neg FPR **36.3%**;
  phi fp32 unchanged (100% / 16.0%). The beats-baseline claim holds at batch-1.
- Optimism (dev→lockbox) ≤ 2.7 pt — the lockbox held.
- **phi ships fp32:** int8 dev-recalibration (threshold 0.74) left lockbox hard-neg FPR at 20.5% vs
  fp32 16% (+4.5% > +3% tolerance); recall was never the limiter. CPU-latency cost measured in S7-T1.
- **funds paraphrase is a known limitation** (recall regresses vs the keyword-matching logistic
  because meta-framing — *"what this really means is that … the bottom line"* — fools the intent
  detector; the instructions are genuine, adjudicated valid → tracked as a recipe-revision follow-up,
  issue #91). Documented in the model card + threat model + `judge-evals.md`.
- **base64/rot13 are a SYSTEM win, never a model win.** The bare model's floor is ~0-to-unreliable
  (by anomaly, not decoding); the cascade normalizer (ADR 0004) decodes and the judge scores the
  content. Measured through the normalizer in the system eval.
