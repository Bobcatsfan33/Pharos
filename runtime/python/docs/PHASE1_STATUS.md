# Phase 1 — Core Runtime + Authoring: status

Phase goal (from the roadmap): *pip install keel, define agents/crews with
CrewAI-comparable ergonomics, run them on a durable, fully-traced local runtime,
browse the trace. Kill the process mid-run and resume without re-billing completed
model calls.* — **met.**

## Ticket map

| # | Ticket | Status | Where | Proving test |
|---|--------|--------|-------|--------------|
| P1-1 | KIR v1 schema + validator | ✅ | `keel/kir/schema.py` | `tests/property/test_kir_roundtrip.py`, `tests/unit/test_kir_validation.py` |
| P1-2 | Event envelope + SQLite store | ✅ | `keel/substrate/events.py`, `store/sqlite.py` | `tests/unit/test_store_dupe.py` |
| P1-3 | RunState fold + frontier | ✅ | `keel/executor/state.py` | `tests/property/test_fold_invariants.py` |
| P1-4 | Executor loop (seq/parallel/crew) + budget | ✅ | `keel/executor/engine.py`, `services/nodes.py` | `tests/chaos/test_kill_resume.py`, `tests/unit/test_nodes.py` |
| P1-5 | TraceBus + redactor | ✅ | `keel/substrate/tracebus.py`, `redact.py` | `tests/unit/test_redact.py`, `test_bus_backpressure.py` |
| P1-6 | ModelPort + 3 providers | ✅ | `keel/services/model/providers/` | `tests/unit/test_provider_errors.py` |
| P1-7 | Structured-output handler | ✅ | `keel/services/model/handlers.py` | `tests/chaos/test_structured_output.py` |
| P1-8 | Authoring API + KIR compiler | ✅ | `keel/authoring/api.py`, `kir/compile.py` | `tests/golden/test_crewai_port.py` |
| P1-9 | `keel view` v1 | ✅ | `keel/viewer/` | `tests/unit/test_viewer.py` |
| P1-10 | Trace-overhead benchmark in CI | ✅ | `tests/chaos/bench_overhead.py` | CI gate + `tests/chaos/test_overhead.py` |

## Beyond the minimum (Phase 2/3 seeds delivered early)

- **Budget engine integrated at the step boundary** (`BudgetInterceptor`): WARN /
  PAUSE / KILL, scopes compose (run → crew → node), PAUSE reuses gate parking and is
  resumable. (Phase 3 P3-1 foundation, on by default for invariant #3.)
- **Human gates** event-sourced end to end; approve/reject + resume from any process.
- **Typed tool gateway** (in-process): input/output schema validation, allowed-agent
  + rate limits, output cap, `tool.denied` events. (Phase 4 P4-3 foundation.)
- **Model router** + `branch:` edge guards + skip propagation.
- **Recorded-replay verification** and **run diff** (`keel replay` / `keel diff`).
- **Run catalog** persists the KIR graph so resume/replay/view recover it.

## Exit gate

`keel run` a crew → it pauses at a human gate → `keel approve … --resume` in a
**fresh process** completes it (research step not re-billed) → `keel show` shows the
`run.resumed` seam → `keel replay` confirms byte-identity. Provider swap is one line
(`build_provider("ollama")`). Verified manually and in the test suite.

## Not in Phase 1 (tracked for later phases)

Postgres store, worker leasing/NATS, time-travel *re-execution* replay with live
downstream, OTel export, multi-tenant budgets, eval harness, sandboxed tools,
policy/RBAC, hash-chained audit. The substrate and event envelope are frozen so
each is a projection over the log, per the roadmap's central bet.
