# ADR-0002: Event envelope schema & blob-store layout

- Status: accepted
- Date: 2026-06-10

## Context
State is a fold over events; the envelope is the most load-bearing contract in the system.

## Decision
Frozen envelope: event_id, run_id, seq (strictly monotonic per run), ts, type, node_id,
attempt, payload_ref, tokens, cost_usd, parent_span, data. Small/queryable fields inline
in `data`; large payloads in a content-addressed blob store referenced by `payload_ref`.
`(run_id, seq)` is a primary key — duplicate writes are rejected, not duplicated.
Frozen at Phase 1 exit; changes require ADR + migration.

## Consequences
10k-event runs fold within the perf budget. Durability, observability, cost, evals, and
audit are all derived from this one stream.
