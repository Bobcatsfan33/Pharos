# Phase 4 — Evals, Integration Layer, Governance → GA: status

Phase goal (roadmap): *recorded reality becomes the test suite; tools become typed,
evented, and sandboxed; the runtime enforces policy at the boundary and produces
audit-grade records.*

## Ticket map

| # | Ticket | Status | Where | Proving test |
|---|--------|--------|-------|--------------|
| P4-1 | Eval harness + 5 assertion types | ✅ | `services/evals/` | `tests/unit/test_assertions.py` |
| P4-2 | `keel test record` + JUnit + flake | ✅ | `services/evals/junit.py`, `cli.py` | `tests/unit/test_record_case.py` |
| P4-3 | Out-of-process tool sandbox | ✅ | `services/tools/sandbox*.py` | `tests/chaos/test_tool_sandbox.py` (red-team) |
| P4-4 | Webhook/NATS triggers (HMAC) | ✅ | `services/triggers.py` | `tests/unit/test_triggers.py` |
| P4-5 | Policy engine + RBAC (boundary) | ✅ | `services/policy.py` | `tests/chaos/test_policy_redteam.py` |
| P4-6 | Hash-chained audit + export/verify | ✅ | `services/audit.py`, `cli.py` | `tests/unit/test_audit_chain.py` |
| P4-7 | `keel import crewai` | ✅ | `services/import_crewai.py` | `tests/golden/test_crewai_import.py` |
| P4-8 | GA load (zero data loss) | ✅ (scaled + 5k module) | `tests/chaos/test_load_5k.py` | in-suite 600 runs; `python -m tests.chaos.test_load_5k` for 5k |
| P4-9 | Reproducible benchmark page | ✅ | `bench/run_benchmarks.py`, `docs/BENCHMARKS.md` | `python -m bench.run_benchmarks` |

## Highlights

- **Eval harness (P4-1)**: a recorded run + assertions over named steps becomes a
  regression test. Five assertion types (exact, schema, numeric tolerance, semantic
  similarity, pinned-judge LLM); `run_suite` runs each case N times and flags flaky
  cases as a distinct outcome from failures.
- **Tool sandbox (P4-3)**: tools run out-of-process under `open()`/`socket()`
  capability gating derived from the contract. Red-team: filesystem and network
  escapes are blocked (`sandbox_violation`) and malformed output is caught
  (`invalid_output`) — nothing undeclared reaches an agent.
- **Policy + RBAC (P4-5)**: enforced at the L3 boundary the gateway must cross, not as
  prompt text. 20 scripted violations → 20 blocks + 20 `policy.violation` events, 0
  tools executed.
- **Audit (P4-6)**: a hash chain over the event sequence (projection, no envelope
  change); `keel audit export` writes a signed bundle and `keel audit verify`
  independently detects any edit/reorder/drop/insert.
- **Triggers (P4-4)**: `POST /v1/triggers/<graph>` with HMAC starts a run; NATS too. HTTP
  deliveries support a durable `Idempotency-Key` claim: exact retries replay the existing run and
  key reuse with changed content is refused.
- **Import (P4-7)**: CrewAI `agents.yaml` + `tasks.yaml` → KIR, preserving roles and
  task→task dependencies; unconverted features are reported, not guessed.

## GA criteria

The five invariants hold under the chaos + load suites; provider swap, durability,
budgets, governance, and audit are all demonstrated by tests. The public benchmark
page is reproducible via `bench/run_benchmarks.py`. Remaining GA items are
operational, not code: a real third-party pentest, a live multi-node 24h soak, and
validated migrations with external design partners.
