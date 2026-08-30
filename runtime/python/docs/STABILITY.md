# Stability & longevity

"Built to last" means a run recorded today is still readable, replayable, and
understandable years from now, and that the surfaces you build on don't shift under you
without warning. This document is the contract.

## The durability guarantee outlives the code

The load-bearing promise: **a run recorded on schema *n* replays on schema *n+1*.** The
event log is the source of truth and is append-only; the `Event` envelope carries a
`schema_version`, and any change to the event shape ships with a read-time **upcaster**
so old logs migrate forward on read without rewriting history. The golden corpus
(`tests/golden`) gates this in CI: recorded fixtures from earlier schemas must still
replay byte-identically. See `docs/EVENT-SCHEMA.md`.

This is why "built to last" is a *tested* property, not an aspiration: you cannot land a
schema change that orphans an existing log.

## Versioning

KEEL follows semantic versioning once it reaches 1.0. Pre-1.0 (current), minor versions
may contain breaking changes, but:

- the **event-log format** is forward-compatible across versions via upcasters (above);
- the **regression bundle format** (`keel.regression/1`) is versioned in its `format`
  field; a new format is a new version string, never a silent reinterpretation.

## Stable surfaces

These are the surfaces external code and contributors build on. Breaking changes to them
require an ADR (`docs/adr/`) and a deprecation cycle:

| Surface | Where | Notes |
|---------|-------|-------|
| Event envelope | `keel/substrate/events.py` | versioned; changes need an upcaster |
| KIR graph contract | `keel/kir/schema.py` | the IR the executor runs |
| Adapter contract | `keel/adapters/base.py` (`AgentNode`, `TracedModel`, `run_agent`, `replay_agent`) | what adapter authors build on; see `docs/ADAPTER-AUTHORS.md` |
| Conformance suite | `keel/adapters/conformance.py` (`assert_conforms`) | the bar every adapter meets |
| Regression bundle | `keel/services/regression.py` (`keel.regression/1`) | versioned format |
| CLI verbs | `keel run|resume|replay|regress|view|…` | flags may be added, not removed without deprecation |

Internal surfaces (everything else, including handler internals, the viewer SPA, and
benchmark harnesses) may change between versions without a deprecation cycle.

## Deprecation policy

A stable surface is removed only after: (1) it is marked deprecated in code and docs in
one release, (2) a migration path is documented, and (3) at least one subsequent release
has shipped with the deprecation in place. Deprecations are noted in `CHANGELOG.md`.

## Supported runtimes

- **Python**: 3.11+ (declared in `pyproject.toml`). Dropping a minor Python version is a
  breaking change subject to the deprecation policy.
- **Core install is lean**: SQLite + content-addressed blobs, no extra services.
  Postgres, NATS, the viewer, and each framework adapter are opt-in extras. Adding a
  hard runtime dependency to the core requires an ADR.

## Why you can rely on this

Longevity is enforced by the same machinery as everything else in KEEL: the golden
corpus and regression suite fail CI if an old log stops replaying, `import-linter` keeps
the layers from tangling, and `mypy --strict` + the determinism lint keep the substrate
honest. The guarantees are gated, not promised.
