# The decision cascade (Sprint 2 — Lantern)

The cascade is the central technical claim of Pharos: deterministic, citation-backed
verdicts under a hard latency budget. It is implemented in
[`@pharos/cascade`](../packages/cascade/src/cascade.ts) and served on `POST /v1/actions`.

## Tiers

| Tier | What | Module | Short-circuit |
|------|------|--------|---------------|
| 1 | Deterministic rules: mandate limits, expiry, deny lists, irreversible-oversight | [`@pharos/core` VerdictEngine](../packages/core/src/verdict/engine.ts) | a **block** ends the cascade (Tiers 2–3 skipped) |
| 2 | Statistical risk score (log-scaled financial magnitude, irreversibility, oversight, mandate, action sensitivity) | [`riskScorer.ts`](../packages/cascade/src/riskScorer.ts) | extreme risk (≥ 0.9) escalates without Tier 3 |
| 3 | Served distilled judge models (FINRA promissory, PHI-in-context, funds-movement intent) | [`@pharos/judge`](../packages/judge/src/model.ts) | terminal tier |

Each tier is instrumented; `verdict.latency.perTier` records the milliseconds spent in each,
and the absence of a `"3"` entry is itself evidence that the cascade short-circuited earlier.

The most severe outcome across tiers wins (`block > escalate > modify > allow`). Every
Tier-3 verdict cites the exact `judgeVersion` (a content hash of the model artifact) that
drove the decision.

## Served judge models

Tier 3 is a model registry of versioned, per-pack binary classifiers — the sub-1B-class
"small model", here a CPU-feasible distilled linear model trained from labeled data
(`pnpm judges:train`, deterministic). The registry serves the active model per pack and
retains historical versions for replay. The interface (featurize → score → calibrated
probability) is identical to a transformer judge, so the model can be upgraded without
touching the cascade. Semantic decisions are made by **learned weights, not regex** (see
[benchmarks/latency.md](benchmarks/latency.md#determinism--no-regex-in-semantic-evaluation)).

## Deadline & engineered fail modes

The whole cascade runs under a hard deadline (default 800ms,
[`deadline.ts`](../packages/cascade/src/deadline.ts)). On timeout **or** a Tier-3 fault, the
cascade returns an engineered fail-mode verdict — and that verdict is sealed as evidence
explaining itself:

| Action | Fail mode | Decision | Rationale |
|--------|-----------|----------|-----------|
| reversible | `fail_open` | allow + async review | don't block reversible work on an internal hiccup |
| irreversible | `fail_closed` | escalate to human | never let an irreversible action through on uncertainty |

## Chaos coverage

The chaos behavior is exercised in tests, not just asserted in prose:

- **Judge fault** (`faults.judgeThrows`) — `cascade.test.ts` and `integration.lantern.test.ts`
  verify reversible→fail-open and irreversible→fail-closed, with the fail mode sealed into the
  evidence record.
- **Deadline breach** (slow judge) — `cascade.test.ts` verifies a fail-mode verdict with
  `latency.deadlineBreached = true`.
- **Postgres down mid-verdict** — `integration.lantern.test.ts` verifies that with the
  database unavailable no partial/unsealed verdict is returned (verdict + evidence are atomic;
  the Sprint 0 guarantee holds under fault).
- **Redis down** — the verdict cache and rate limiter fail open (best-effort); verdicts are
  unaffected because the authoritative path is Postgres + WORM, not the cache.

## Reproducibility

Given the same policy, judge versions, and inputs, the cascade is deterministic. A verdict's
**fingerprint** is the SHA-256 of its decision content (everything except wall-clock latency,
[`reproduce.ts`](../packages/cascade/src/reproduce.ts)). `GET /v1/replay/:tenant/:sequence`
re-evaluates a sealed record's inputs and confirms the fingerprint is bit-identical to the
one originally sealed — proven for 10 sampled verdicts in `integration.lantern.test.ts`.
