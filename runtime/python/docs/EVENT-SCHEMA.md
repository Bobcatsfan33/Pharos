# Event envelope & schema evolution

KEEL's durability rests on an append-only event log. That log outlives the software
that wrote it, so the envelope is **versioned** and old logs are migrated forward at
read time — never rewritten in place.

## The envelope (frozen shape, versioned)

Every event is a `keel.substrate.events.Event` carrying:

| Field | Meaning |
|-------|---------|
| `schema_version` | the envelope version this event was written under (current: `SCHEMA_VERSION`) |
| `event_id` | sortable ULID, from the `IdGen` port |
| `run_id`, `seq` | the run and its strictly-monotonic, gap-free sequence number |
| `ts` | timestamp from the `Clock` port |
| `type` | the `EventType` (an open, additive enum) |
| `node_id`, `attempt` | the step this event belongs to, and its attempt |
| `payload_ref` | `blob:sha256:…` reference; large payloads live in the content-addressed blob store, the log stays small |
| `tokens`, `cost_usd` | per-event usage and spend (the budget chokepoint) |
| `data` | small, inline, queryable fields (route reason, gate decision, idempotency key, …) |

The **shape** is frozen; the `type` enum and `schema_version` grow additively. A
change to a field's meaning or removal requires a version bump **plus an upcaster**.

## Upcasting (read-time migration)

`keel.substrate.upcast` holds a registry of pure transforms. An upcaster registered
for version *n* migrates an event dict from *n* to *n+1*:

```python
from keel.substrate.upcast import register_upcaster

def v1_to_v2(d: dict) -> dict:
    d["data"] = {**d.get("data", {})}
    d["data"]["model"] = d["data"].pop("legacy_model", "")   # example migration
    return d

register_upcaster(1, v1_to_v2)   # then bump SCHEMA_VERSION to 2
```

On read, every store routes bodies through `read_event`, which dispatches on
`schema_version`, applies the chain up to the current version, and validates. Replay
and folding always operate on the **latest in-memory shape**; the on-disk log is never
modified (append-only is preserved).

A missing upcaster (an old event the reader can't migrate) or a future version (newer
than the reader) raises `UnreadableEvent` — surfaced loudly, never silently dropped.

## Guarantees, gated in CI

- **Cross-version replay.** A run recorded under schema *n* replays under *n+1* via the
  upcaster chain. The golden corpus (`tests/golden/corpus/*.json`) is a set of committed
  historical logs replayed byte-identically on every PR
  (`tests/golden/test_golden_corpus.py`). **A schema change that breaks old-log replay
  fails CI until an upcaster is supplied** — and that failure mode is itself tested.
- **Loud on gaps.** `keel migrate [<run_id>]` reads every event in a store under the
  current schema and reports any run whose events can't be upcast (exit non-zero).

## Compatibility policy

The envelope `schema_version` follows the project's compatibility commitment: a log
written by any released KEEL version remains readable by every later version through the
upcaster chain. New `EventType` values and new `data` keys are additive and need no
upcaster. Renames, removals, or meaning changes require a version bump + upcaster + a
golden-corpus entry in the same PR.
