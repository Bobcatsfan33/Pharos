# Phase 2 — Durability at Depth + Observability Product: status

Phase goal (roadmap): *runs survive anything, pause for humans indefinitely with
zero compute while parked, replay with time-travel; traces flow into the customer's
existing observability stack.*

## Ticket map

| # | Ticket | Status | Where | Proving test |
|---|--------|--------|-------|--------------|
| P2-1 | Postgres event store behind EventStore | ✅ (adapter) | `keel/substrate/store/postgres.py` | `tests/unit/test_pg_parity.py` (needs `DATABASE_URL`) |
| P2-2 | Worker leasing + heartbeat/steal | ✅ | `keel/executor/lease.py`, `services/worker.py` | `tests/chaos/test_worker_kill.py` |
| P2-3 | NATS JetStream scheduler | ✅ (adapter) | `keel/services/scheduler.py`, `scheduler_nats.py` | `tests/unit/test_scheduler_nats.py` (needs `NATS_URL`) |
| P2-4 | Human-gate node + GateService API | ✅ | `keel/services/gate_service.py`, `executor/gate.py` | `tests/unit/test_gate_webhook.py`, `test_runner.py` |
| P2-5 | Gate UI + webhook notify | ✅ | `keel/services/notify.py`, `viewer/` | `tests/unit/test_gate_webhook.py`, `test_viewer.py` |
| P2-6 | Time-travel replay (`keel replay`) | ✅ | `keel/services/replay.py` | `tests/unit/test_replay_identity.py` |
| P2-7 | Trace diffing (`keel diff`) | ✅ | `keel/executor/replay.py`, viewer `/api/diff` | `tests/unit/test_replay_identity.py`, viewer test |
| P2-8 | OTel GenAI export | ✅ | `keel/substrate/otel.py` | `tests/unit/test_otel_spans.py` |
| P2-9 | Memory subsystem v1 (KV + vector) | ✅ | `keel/services/memory.py` | `tests/unit/test_memory_traced.py` |
| P2-10 | Viewer v2 (timeline + gate + diff) | ✅ | `keel/viewer/` | `tests/chaos/bench_viewer.py` (10k events) |

## Highlights

- **Time-travel replay** re-drives a run through `ReplayClock`/`ReplayIdGen` with a
  `RecordedModelPort` feeding recorded outputs back — byte-identical, with any
  divergence flagged (not silently re-called live). Patched replay seeds upstream
  from the log and runs descendants live, so divergence is confined downstream.
- **Worker leasing** lets any worker resume any run; a stolen lease + `(run_id,seq)`
  uniqueness mean a partition can't corrupt the log. Chaos test: a concurrent pool
  with at-least-once delivery completes every run, zero re-billing, logs sound.
- **Gates** park with zero compute; `GateService` makes approval a log append +
  re-enqueue (worker/process/machine-agnostic); a `WebhookNotifier` fires on
  gate-open. The viewer has approve/reject buttons and a diff view.
- **Observability**: OTel GenAI spans (run → step nesting, token/cost attrs); the
  viewer renders a 9k-event run in <100ms.

## Bug found & fixed in-phase

The KIR acyclicity check was recursive DFS and blew the Python recursion limit on
deep chains (caught by the 10k-event viewer benchmark). Rewritten with Kahn's
algorithm (iterative); regression tests cover a 3000-node chain and a 500-node cycle.

## Needs live infrastructure (code complete, tests conditional)

- Postgres parity test runs against `DATABASE_URL`; NATS test against `NATS_URL`.
- The full production soak (3 workers, random kills, 500 concurrent, 1h) is an infra
  test; its mechanisms are proven deterministically here.
