# Working in this repository (for coding agents and humans alike)

Pharos sells trust. The one rule that matters more than any other: **a claim the code cannot
back is a bug, wherever it appears** — README, docs, a PR description, a CLI help string.

## Shape

- `packages/*` — the TypeScript control plane (pnpm workspace). `core` is pure; everything
  depends downward; `services/api/src/platform.ts` is the composition root.
- `sdks/python` — the Python SDK (`getpharos`, stdlib only).
- `runtime/python` — Pharos Runtime, the Python durable executor. Talks to the control plane
  through the SDK.
- `docs/` — user and contributor docs. `docs/internal/` — roadmaps, status, handoffs,
  evidence; read for context, never cite as a product claim.
- [`docs/architecture.md`](docs/architecture.md) is the map; [`CONTRIBUTING.md`](CONTRIBUTING.md)
  says where a change goes and which registry it uses.

## Commands

```bash
pnpm install && cp .env.example .env && pnpm infra:up
pnpm build:publishable            # before typecheck: workspaces resolve the SDK through dist
pnpm -r typecheck && pnpm lint && pnpm format:check
pnpm test                         # against real Postgres / Redis / MinIO; a skipped integration test fails CI
pnpm runtime:install && pnpm runtime:check
pnpm demo && pnpm verify:bundle evidence-bundle.json
```

## Invariants

1. A verdict is never returned before its record is durably sealed in the same transaction.
2. `ActionRecord` v1 is frozen. Canonicalisation, hashing, chain and seal formats change only
   behind an ADR. The wire vocabulary lives in `packages/pdp-spec/src/schema.ts`; regenerate
   the JSON Schema and the Python types after touching it (`pnpm --filter @getpharos/pdp-spec
   generate && python3 sdks/python/scripts/gen_types.py`).
3. Extension is by registration, not by editing a central list. New signing, TSA and judge
   backends register from their own files; packs are JSON files discovered from
   `packages/policy/packs/`.
4. No judge is promoted; `docs/internal/enterprise-readiness.json` keeps its decision field
   unless a human changes it.
5. Keep `docs/LIMITATIONS.md` true: delete an entry when the code catches up, add one when a
   change leaves a gap.
6. Configuration is rendered through `packages/config` and passed down; never read the
   environment at the point of use.
7. DCO sign-off on every commit; a changeset for every publishable npm package change; one
   concern per PR; no sprint or task identifiers in code.
