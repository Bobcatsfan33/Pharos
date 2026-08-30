# ADR-0007: Memory subsystem trace events

- Status: accepted
- Date: 2026-06-11

## Context
The Phase-1 event envelope is frozen. Phase 2 adds a memory subsystem (KV + vector)
whose reads and writes must be visible so the context an agent received is
reconstructable from the log (invariant #1). That requires representing memory
operations in the event stream.

## Decision
Add two **additive** `EventType` values — `memory.read` and `memory.write`. The
`Event` envelope's fields are unchanged; only the open-ended type enum grows. Older
logs still parse (no value was renamed or removed), so this does not break the freeze
on the envelope *shape* — it extends the taxonomy, which the envelope was designed to
allow. Memory access flows exclusively through `TracedMemory`, which emits these
events; there is no untraced memory path. Memory is disable-able via a single flag.

## Consequences
- The viewer, cost/audit projections, and replay all see memory ops for free.
- Adding further additive event types in later phases follows this same ADR pattern.
- A real embedder swaps in behind the `Embedder` port without touching the events.
