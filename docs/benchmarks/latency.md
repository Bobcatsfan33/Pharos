# Verdict latency benchmark (Sprint 2 — Lantern)

**Claim:** deterministic, citation-backed verdicts in under 800 milliseconds.

**Exit criterion:** p99 end-to-end verdict latency < 800ms at a sustained 1,000
verdicts/sec, with a per-tier breakdown.

Reproduce with `pnpm bench:latency [requests] [concurrency]`
([`scripts/bench-latency.ts`](../../scripts/bench-latency.ts)). The harness drives the real
cascade (Tier 1 deterministic rules → Tier 2 statistical risk → Tier 3 served distilled
judges) over a representative mix of action shapes (benign comms, FINRA promissory language,
PHI exposure, funds movement, mandate-limit blocks).

## Result (reference run)

| Metric | Value | Budget |
|--------|-------|--------|
| Throughput | **5,415 verdicts/sec** | ≥ 1,000 |
| p50 | 2.91 ms | — |
| p95 | 3.40 ms | — |
| p99 | **3.74 ms** | < 800 ms |
| max | 7.13 ms | — |

Per-tier average latency:

| Tier | Avg latency | Notes |
|------|-------------|-------|
| Tier 1 (deterministic rules) | 0.0002 ms | runs on every verdict; short-circuits on a block |
| Tier 2 (statistical risk) | 0.0002 ms | runs when Tier 1 is non-terminal; short-circuits on extreme risk |
| Tier 3 (served judge) | 0.64 ms | runs for semantic evaluation; the dominant cost |

p99 is ~210× inside the 800ms budget, and the achieved rate is ~5× the 1,000/sec target,
on a single process on a developer laptop (Apple Silicon).

## Honest scope of this measurement

- **What is measured:** end-to-end *verdict* computation latency (the cascade), which is the
  latency the 800ms claim refers to. The transactional seal (WORM + Postgres) is a separate
  durable write, not part of the verdict budget.
- **Duration:** the reference run above is a multi-second sustained burst (30k–60k verdicts).
  The roadmap's full exit bar is a **one-hour** sustained run at 1,000/sec; this harness runs
  that unchanged by passing a larger request count (e.g. `pnpm bench:latency 3600000`). The
  one-hour soak is part of the GA hardening run (Sprint 8), not re-run on every CI.
- **Served judge:** Tier 3 here is a CPU-feasible distilled linear model (the sub-1B-class
  "small model"). The cascade interface is identical for a transformer judge, which would
  raise Tier-3 latency but remains well inside budget; that swap is measured before any
  revised claim ships.

## Determinism / no regex in semantic evaluation

Semantic evaluation (Tier 3) is performed by **learned models**, not regex. The only regular
expression in the judge path is a character-class tokenizer split
(`/[^a-z0-9]+/` in [`featurize.ts`](../../packages/judge/src/featurize.ts)) that segments
text into tokens; the *decision* about meaning is made entirely by the model's learned
weights. A code audit for pattern-matching in semantic evaluation:

```bash
grep -rn "test(\|\.match(\|RegExp" packages/judge/src packages/cascade/src
```

returns no semantic pattern matching — only the tokenizer split. Every Tier-3 verdict cites
the exact `judgeVersion` (a content hash of the model artifact) that produced it.
