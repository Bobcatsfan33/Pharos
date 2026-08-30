# When *not* to use KEEL

KEEL is durable execution for LLM agents. That has a real cost — every step writes
events to an append-only log — and it buys you nothing if your workload doesn't need
durability, replay, or recorded-run regression testing. Honest non-fit cases:

- **Single-shot prompts.** One model call with no multi-step state, no tools, and no
  human gate. The event log is pure overhead; call the provider SDK directly.
- **Latency-critical hot paths.** If a few milliseconds of trace-bus + persistence per
  step matters more than the ability to resume or replay, KEEL is the wrong layer.
  Measure first (see [`BENCHMARKS.md`](BENCHMARKS.md)); the overhead is small but it is
  not zero.
- **Throwaway scripts and notebooks.** Exploratory work you will never resume, replay,
  or regression-test doesn't benefit from the machinery.
- **You need a high-level authoring framework.** KEEL is deliberately *not* competing on
  `Agent`/`Task`/`Crew` ergonomics — that space is well served. If you want an opinionated
  authoring DSL, use CrewAI or LangGraph and (soon) run it *under* KEEL via an adapter.
- **Hard real-time or sub-millisecond budgets.** The event-sourced model assumes you can
  afford a durable write on the critical path.

## Use KEEL when

- A run spans **multiple billed model calls and/or tool side effects** and a crash or
  deploy mid-run must not re-bill or re-execute completed work.
- You want **any production run to become a regression test** that fails CI on routing,
  cost, or output drift.
- You need **per-run budgets**, **human-in-the-loop gates** that park for an unbounded
  time, **audit-grade records**, or **deterministic replay** for debugging.

## Maturity (read before depending on it)

- **Early-stage, single-maintainer.** Continuity risk is real; see the governance and
  branch-protection notes in [`SDLC-POLICY.md`](SDLC-POLICY.md).
- **Not independently audited.** No third-party security audit or penetration test yet.
- **Not soak-tested across nodes in production.** Multi-worker leasing and Postgres/NATS
  backends exist and are tested, but a long-running multi-node soak is still pending
  (tracked in the strategy as M6).
- **Determinism has documented limits today.** Streaming, tool-call replay, and
  arbitrary environment/filesystem/network access in handlers are not yet fully on the
  deterministic path — see [`DETERMINISM.md`](DETERMINISM.md). M1 closes these and the
  README will only claim what the conformance suite proves.

If those limits are acceptable for your use case, KEEL is usable today; if not, the
strategy doc shows exactly when each gap closes and how it's proven.
