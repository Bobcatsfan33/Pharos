# KEEL strategy — one product, one sentence

> **KEEL is durable execution for LLM agents.** A run is an append-only event log; any
> run resumes after a crash from its last completed step, replays byte-identically, and
> never re-bills a completed model call. Bring your own framework — KEEL is the runtime
> that makes it survive production.

Three consequences shape everything:

1. **The substrate is the moat.** L1 (ports, trace bus, storage) and L2 (the durable,
   event-sourced executor) get the deepest investment. Determinism and durability are
   the product; everything else is distribution for them.
2. **Frameworks are distribution, not competition.** KEEL runs *underneath* LangGraph,
   CrewAI, the OpenAI Agents SDK, and the Anthropic SDK. The L5 DSL is an optional
   convenience, explicitly out of the headline.
3. **Claims ship only after proof.** "Byte-identical replay," "never re-billed," and any
   overhead/latency number appear in the README **only after** the conformance suite,
   fault-injection test, or benchmark that proves it exists and passes in CI.

The category — durable execution — is owned for ordinary services by Temporal, Inngest,
DBOS, and Restate. KEEL's wedge is the LLM-specific hard parts they don't address:
non-deterministic model calls, token-metered cost, streaming, tool side effects, and
human-in-the-loop gates, all inside a deterministic replay model.

## Milestones (proof-gated, date-free)

| # | Milestone | Headline proof |
|---|-----------|----------------|
| M0 | One Product, One Sentence | Durable-execution positioning; L5 demoted; determinism contract + "when not to use" published |
| M1 | Determinism You Can Trust | 50+ runs replay byte-identical; chaos proves side-effect-once; nondeterminism lint gate |
| M2 | Durable Across Change | A run recorded on schema *n* replays on *n+1*; golden corpus gates CI |
| M3 | Replay Demo & Frictionless First Run | No-key run < 2 min; crash/resume with unchanged cost; read-only viewer |
| M4 | Runtime Under the Frameworks | A real OSS LangGraph/CrewAI example runs unmodified, crashes, resumes, replays |
| M5 | Regression Testing as a Workflow | GitHub Action replays runs on PRs and blocks regressions; KEEL dogfoods it |
| M6 | Prove the Numbers | Reproducible p50/p95/p99 + overhead %; 24h multi-worker soak clean |
| M7 | Adoptable and Built to Last | External contribution merged; security/governance live; independent review |

Sequence de-risks the next step: positioning precedes engineering, determinism precedes
adapters, proof precedes promotion. Re-ordering is permitted only where a milestone's
dependency notes allow it.

## Kill criterion

If, after M1's full effort, the core cannot deliver byte-identical replay for the common
case (model + idempotent tools + gates), stop and re-scope the thesis before shipping any
"byte-identical" claim. A durable runtime that can't replay is not the product.

Per-milestone implementation status is tracked in `docs/Mx_STATUS.md` as each lands.
