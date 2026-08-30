# ADR-0001: KIR v1 node taxonomy & versioning

- Status: accepted
- Date: 2026-06-10

## Context
Every authoring surface (Agent/Task/Crew, decorators, future styles) must compile to
one runtime contract so the executor stays stable while DX evolves.

## Decision
KIR v1 node types: llm_step, tool_step, router, map, reduce, human_gate, subgraph,
crew. KIR is versioned (`kir_version`), JSON-serializable, and validated (acyclic at
top level; loops confined to `crew` regions bounded by a Region contract). Schema
changes bump the version and ship a migration.

## Consequences
Replay, resume, cost simulation, and visualization are all projections over KIR +
the event log. New authoring styles never touch the runtime.

## Alternatives considered
Direct execution of authoring objects — rejected: couples runtime to DX, breaks replay.
