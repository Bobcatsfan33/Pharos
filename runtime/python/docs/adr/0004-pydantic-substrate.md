# ADR-0004: Pydantic v2 as the schema substrate

- Status: accepted
- Date: 2026-06-11

## Context
KIR nodes, the event envelope, model requests/responses, tool contracts, and
structured-output validation all need a single, fast, typed schema layer. We want
frozen/immutable models (events are never mutated; KIR is pure data), JSON
round-tripping, and JSON-Schema generation (for structured output and tool I/O).

## Decision
Pydantic v2 is the schema substrate across L1–L5. Models that represent recorded
or contractual data use `ConfigDict(frozen=True)`. The structured-output handler
and tool gateway validate against models resolved from string refs via the
`kir.schemas_registry`, keeping KIR itself serializable.

## Consequences
- `mypy --strict` + Pydantic validation cover both static and runtime correctness.
- JSON Schema for structured output / tool contracts comes for free
  (`model_json_schema()`).
- A core dependency; adding others to core still requires an ADR.
