# ADR-0006: Viewer stack

- Status: accepted (Phase 1); React/Vite bundle deferred
- Date: 2026-06-11

## Context
`keel view` must render a run's timeline, step drill-down, and cost rollup over the
event log, with no SSR and no heavy build step blocking `pip install 'keel[viewer]'`.

## Decision
FastAPI serves a small JSON API (run list, folded run detail, cost rollup, blob
fetch) plus a **dependency-free single-file SPA** (vanilla JS in `viewer/spa.py`).
The JSON API is the stable contract. The React/Vite bundle the roadmap envisions is
a later swap behind that same API and is deferred until the viewer's surface grows
past what one file comfortably holds.

## Consequences
- Zero front-end build step; the viewer works the moment the extra is installed.
- Everything shown is a projection over the event log — no separate pipeline.
- When the UI grows (Phase 2 gate/diff/timeline views at scale), revisit with a
  bundled SPA without changing the API.
