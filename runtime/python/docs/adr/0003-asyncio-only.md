# ADR-0003: asyncio-only vs anyio

- Status: accepted (asyncio-only for v1)
- Date: 2026-06-10

## Context
The executor and trace bus are concurrency-heavy; we want one model, not two.

## Decision
asyncio-only for v1. Revisit anyio only if a concrete Trio requirement appears.

## Consequences
Simpler mental model and tooling; node handlers are coroutines, parallel frontier
execution is `asyncio.gather`.
