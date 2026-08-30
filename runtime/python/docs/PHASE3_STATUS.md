# Phase 3 — Cost Governance + Reliability: status

Phase goal (roadmap): *spend is a managed, simulated, attributed resource; the
runtime is rate-limit-aware and degrades gracefully under provider 429 storms.*

## Ticket map

| # | Ticket | Status | Where | Proving test |
|---|--------|--------|-------|--------------|
| P3-1 | Budget engine (run/node/crew/tenant scopes) | ✅ | `executor/engine.py` (emit chokepoint), `services/budget.py` | `tests/chaos/test_budget_no_bypass.py` |
| P3-2 | Model router + model_policy escalation | ✅ | `services/model/router.py`, `model/handlers.py` | `tests/golden/test_router_quality.py` |
| P3-3 | Rate-limit-aware scheduler (token buckets) | ✅ | `services/model/ratelimit.py` | `tests/chaos/test_429_storm.py` |
| P3-4 | Context compiler (staged, measured) | ✅ | `services/context.py` | `tests/golden/test_context_tokens.py` |
| P3-5 | Cost simulation (`keel simulate`) | ✅ | `services/simulate.py` | `tests/golden/test_simulation_accuracy.py` |
| P3-6 | Versioned price tables + CI gate | ✅ | `services/model/pricing.py` | `tests/unit/test_pricing.py` |
| P3-7 | Cost dashboard in viewer | ✅ | `services/cost.py`, `viewer/` | `tests/unit/test_cost_rollup.py` |

## Highlights

- **No-bypass budget (P3-1)**: spend is metered at `RunContext.emit` — the single
  chokepoint every cost/token event flows through — so retry attempts and
  crew-region spend are all counted. The chaos test proves a failed retry's spend is
  charged, a 5-step crew is halted at the run's 3-step budget, and committed spend
  equals the sum of event costs (chokepoint == log). Scopes compose
  tenant → run → crew → node.
- **Cheap-first routing (P3-2)**: a schema/validation failure escalates the step to
  the next candidate on the policy ladder; the small model serves ≥60% of steps with
  end-quality within 2% of all-frontier, and every choice emits a `route.decided`.
- **429 resilience (P3-3)**: provider `ModelError` maps to `RetryableError`, so the
  executor's per-node retry/backoff absorbs a 429 burst — zero failed runs. A token
  bucket paces requests (interactive preempts batch).
- **Context compiler (P3-4)**: staged, measured assembly cuts ≥25% of tokens via
  top-k memory + history summarization; per-stage token contributions are recorded so
  the prompt is reconstructable.
- **Cost as a resource (P3-5/6/7)**: `keel simulate` estimates within 15% of actual;
  prices are a versioned, checksum-gated table; the viewer rolls spend up by
  graph/model/node/tenant/day with a most-expensive-step board.

## Exit gate

`tests/chaos/test_phase3_exit_gate.py`: a $2 budget on a ~$6 pipeline pauses with
full state inside one step boundary; raising the budget and resuming completes it
with no re-billing. Router escalation is visible in the trace
(`tests/golden/test_router_quality.py`); simulate-vs-actual is checked in
`tests/golden/test_simulation_accuracy.py`.

## Notes

The production 429-storm soak (p95 degradation < 2× at scale) is an infra test; the
mechanism (retry/backoff + token bucket) is proven deterministically here.
Cross-run tenant budgets accumulate per Runner instance; a shared persistent tenant
meter is a later addition.
