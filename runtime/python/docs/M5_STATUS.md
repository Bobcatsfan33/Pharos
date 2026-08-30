# M5 — Regression Testing as a Workflow — STATUS: DONE

**Headline proof:** *GitHub Action replays runs on PRs and blocks regressions; KEEL
dogfoods it.*

## What shipped

- **`keel/services/regression.py`** — the `RegressionBundle` contract (`keel.regression/1`):
  a self-contained, version-controllable JSON of graph + event log + inlined blobs +
  optional eval case. `capture_bundle()` freezes a recorded run; `check_bundle()` /
  `run_suite()` replay it byte-identically and run its eval case. Catches both
  determinism drift (replay no longer byte-identical) and behavioural drift (eval case
  fails). Replays with no API key and no network.
- **`keel/services/regression_junit.py`** — JUnit XML so replay-as-a-test slots into any
  CI; drift is a failure, flaky evals are skips.
- **`keel regress record|run`** CLI (`keel/cli.py`) — capture a bundle from a recorded
  run; replay a directory of bundles and exit non-zero on regression.
- **`Runner.open(clock=, ids=)`** — optional injectable record-time ports so the dogfood
  suite is captured deterministically and regenerates byte-stably.
- **`.github/workflows/regression.yml`** — replays the committed suite on every PR and
  push to `main`; blocks the merge on drift; uploads the JUnit report.
- **`.github/actions/keel-regress/action.yml`** — a reusable composite action so KEEL
  *users* can gate their own pipelines on byte-identical replay of their recorded runs.
- **Dogfood suite** — `tests/regression/_gen_suite.py` + committed bundles under
  `tests/regression/suite/` (linear pipeline, fan-out/fan-in branch, pipeline with an
  embedded eval case).
- **Tests** — `tests/unit/test_regression.py`: the committed suite replays
  byte-identically; a mutated bundle is caught (determinism *and* behavioural drift);
  capture round-trips standalone; JUnit marks failures and skips.

## Notes / honest limits

- Bundles are captured and replayed under the **default price table**, so cost is
  reproduced byte-identically without carrying price config. (Replaying a run recorded
  under a custom price table would need that table threaded through `replay_recorded`;
  out of scope for the dogfood suite.)
- The eval case in the suite uses a registry-free `EXACT` assertion so the bundle is
  fully self-contained (no global schema-registry dependency at replay time).

See `docs/REGRESSION.md` for usage.
