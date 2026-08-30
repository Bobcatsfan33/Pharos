<!-- Thanks for contributing to KEEL. See CONTRIBUTING.md. -->

## What & why

<!-- What does this change and why? Link any issue. -->

## Type

- [ ] feat  - [ ] fix  - [ ] docs  - [ ] test  - [ ] refactor  - [ ] perf  - [ ] ci

## Guarantees touched

- [ ] This change does **not** alter the event envelope / serialization. (If it does, I
      added an upcaster and the golden corpus still replays — `docs/EVENT-SCHEMA.md`.)
- [ ] This change does **not** introduce nondeterminism outside an L1 port. (Determinism
      lint passes.)
- [ ] The regression suite still replays byte-identically
      (`keel regress run --suite tests/regression/suite`).
- [ ] No stable surface in `docs/STABILITY.md` is broken without an ADR + deprecation.

## Test plan

<!-- Commands you ran and what they proved. New behaviour needs a test that would fail
without this change. -->

```
ruff check keel tests bench && mypy && lint-imports && \
  python -m keel._lint.determinism keel && pytest -q
```
