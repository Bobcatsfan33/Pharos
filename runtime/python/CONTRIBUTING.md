# Contributing to KEEL

Thanks for considering a contribution. KEEL is durable execution for LLM agents; the
bar for a change is that it keeps the core guarantees intact and provable in CI. This
guide is the golden path from a clone to a merged PR.

## Setup

```bash
git clone https://github.com/Bobcatsfan33/keel && cd keel
python -m venv .venv && . .venv/bin/activate   # Python 3.11+
pip install -e ".[dev,viewer]"
```

## The gates your PR must pass

Every PR runs the same checks CI runs (`.github/workflows/ci.yml`). Run them locally
before pushing — green here means green in CI:

```bash
ruff check keel tests bench          # lint
mypy                                 # types (L1–L5, --strict)
lint-imports                         # layer contracts (deps point downward only)
python -m keel._lint.determinism keel  # no nondeterminism bypasses an L1 port
pytest -q                            # unit + property + chaos
python -m tests.chaos.bench_overhead   # trace overhead < 3%
python -m bench.latency              # latency percentiles within ceiling
python -m keel.cli regress run --suite tests/regression/suite  # byte-identical replay
```

Two non-obvious rules the gates enforce, both load-bearing for the product:

- **Downward-only imports.** Layers are `substrate → executor → kir → services →
  authoring → adapters`. Nothing imports upward. `lint-imports` blocks violations.
- **Nondeterminism only through L1 ports.** No `datetime.now()`, `time.time()`,
  `random`, or `uuid` outside `keel/substrate`. Route through the injected `Clock` /
  `Rng` / `IdGen`, or replay diverges. The determinism lint blocks violations; an
  audited exception needs a `# det-ok` comment with a reason.

## What makes a good change

- **Small, focused, tested.** Add or update tests in the same PR. New behaviour without
  a test that would fail without it is unlikely to merge.
- **Prove claims in CI.** KEEL only ships a guarantee after a test proves it (see
  `docs/STRATEGY.md`). If your change asserts "byte-identical" or a performance number,
  add the test or benchmark that backs it.
- **Don't break replay.** If you touch the event envelope, serialization, or a node
  handler, the golden corpus (`tests/golden`) and the regression suite
  (`tests/regression/suite`) must still replay byte-identically. Schema changes require
  an upcaster — see `docs/EVENT-SCHEMA.md`.
- **Respect stability.** See `docs/STABILITY.md` for which surfaces are stable and the
  deprecation policy.

## High-value contributions

- **A new framework adapter** — run another agent framework *under* KEEL. This is the
  most welcome contribution and has a dedicated guide: `docs/ADAPTER-AUTHORS.md`. The
  shared conformance suite proves it; the `pydantic-ai` adapter is the worked example.
- **A regression bundle** from a real run that exercises a path the suite misses.
- **Determinism or durability hardening** with a chaos test that fails without it.

## Submitting

1. Branch from `main`; use a conventional-commit style subject (`feat:`, `fix:`,
   `docs:`, `test:`, `refactor:`, `perf:`, `ci:`).
2. Fill in the PR template, including the test plan.
3. CI must be green. A maintainer reviews security-sensitive paths
   (`CODEOWNERS`) — substrate, executor, and CI/release config.

By contributing you agree your work is licensed under the project's Apache-2.0 license.
See `GOVERNANCE.md` for how decisions are made and how to become a maintainer, and
`SECURITY.md` to report a vulnerability.
