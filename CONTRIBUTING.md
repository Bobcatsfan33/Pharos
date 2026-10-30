# Contributing to Pharos

Thanks for your interest in Pharos. This guide covers local setup, where a change goes, the
rules every change follows, and how to get it merged.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Prerequisites: Node.js ≥ 22, [pnpm](https://pnpm.io) 10.x, Python ≥ 3.11, and Docker for the
local Postgres / Redis / MinIO stack (the control-plane integration suite needs it; the
runtime and the SDKs do not).

```bash
pnpm install
cp .env.example .env
pnpm infra:up                      # Postgres + Redis + MinIO via docker compose
pnpm build:publishable             # the SDK packages other workspaces typecheck against
pnpm test                          # control-plane suite, against the real stack

python3 -m venv .venv && . .venv/bin/activate
pnpm runtime:install               # Pharos SDK + Pharos Runtime, editable
pnpm runtime:check                 # lint, mypy --strict, layer contracts, pytest

pnpm api:dev                       # API on :4000
```

If `pnpm test` is not fully green on your machine, stop and fix your environment before doing
anything else. [`docs/ONBOARDING.md`](docs/ONBOARDING.md) has a verified clean-machine
transcript.

## Where a change goes

The repository is one product with two halves: a TypeScript control plane that decides and
seals, and a Python runtime that executes under it. [`docs/architecture.md`](docs/architecture.md)
has the map; the short version:

| You are adding… | It goes in | And you register it by… |
|---|---|---|
| A signing backend (KMS, HSM, vault) | `packages/core/src/signing/<name>.ts` | `registerSigningProvider("<name>", factory)` in `packages/core/src/signing/registry.ts`; select it with `PHAROS_KMS_PROVIDER=<name>` |
| A trusted-time (TSA) backend | `packages/evidence/src/tsa/<name>.ts` | `registerTsaProvider("<name>", factory)` in `packages/evidence/src/tsa/registry.ts`; select with `PHAROS_TSA_PROVIDER=<name>` |
| A judge-serving backend | `packages/judge/src/<name>.ts` | `registerJudgeProvider("<name>", factory)` in `packages/judge/src/registry.ts`; select with `PHAROS_JUDGE_PROVIDER=<name>` |
| A served judge model (concern) | `packages/judge/models/manifest.json` | Nothing — the manifest is the list of concerns a deployment must serve |
| A policy pack (rules with citations) | `packages/policy/packs/<pack>.json` | Nothing — packs are discovered from the directory and validated against `pack.schema.json`; add its cases to `test/policy.test.ts` |
| A judge concern's routing and verdict | `judgeBindings` in the pack's JSON | Nothing — the cascade's default bindings are derived from the packs |
| A framework middleware (LangChain, OpenAI Agents, …) | `packages/middleware/src/adapters.ts` | Exports a wrapper over `govern`; passes the shared conformance suite in `test/middleware.conformance.test.ts` |
| A governed connector | `packages/connectors/src/<name>.ts` | Implements `ConnectorPlugin` (`plugins.ts`) and passes `runPluginConformance` |
| A runtime framework adapter (Python) | `runtime/python/keel/adapters/<framework>.py` | Ships a `reference_agent()` and passes the adapter conformance suite — see [`runtime/python/docs/ADAPTER-AUTHORS.md`](runtime/python/docs/ADAPTER-AUTHORS.md) |
| An API route | `services/api/src/routes/<area>.ts` | Registered in `services/api/src/app.ts` |

`test/registries.extension.test.ts` is the contract: a new signing, TSA or judge backend
registers from its own file and is selected by configuration, and a new pack file adds a pack
and a concern binding with no code change. If a change needs you to edit a central list to make
something appear, that list is a bug — open an issue rather than growing it.

## Ground rules

1. **Green before and after.** `pnpm -r typecheck && pnpm lint && pnpm test && pnpm runtime:check`
   before you branch and before you open a PR. Do not weaken, skip-list, or conditionalize the
   CI "integration tests must run, not skip" gate to get a PR green.
2. **One concern, one PR.** Branch `<type>/<short-name>` (`feat/vault-signing-provider`,
   `fix/gateway-body-bytes`). If you find a second bug while fixing the first, file it and say
   so in the PR rather than folding it in.
3. **No crypto invention.** You may *call* crypto (KMS SDKs, `jose`, `node:crypto`); you may
   not *design* crypto (new signing schemes, canonicalization, chain formats) without an RFC
   approved by a maintainer.
4. **The frozen schema stays frozen.** `ActionRecord` v1 does not change. New fields go
   through the schema-version machinery with migration adapters, behind an RFC. The wire
   schema has one source — `@getpharos/pdp-spec` — and every other copy is generated from it.
5. **Verdict and evidence are one transaction.** No change may return a verdict before its
   record is durably sealed, or seal a record without its governing context.
6. **Every behavior claim gets a test.** If a doc says "restart-safe," there is a test that
   restarts the thing.
7. **Honest docs.** When you complete a change, update any doc it makes false. Overclaiming
   in docs is a P1 bug in this product. See [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md); it is
   expected to *shrink* as the code catches up, so delete entries you resolve.
8. **Secrets never in the repo.** `.env` files are local; CI uses GitHub secrets. Anything
   that looks like a credential in a PR fails review.

## How this repo is run

Pharos's product claim is *evidence*, so the repo is run the way an evidence system has to
be. Five habits explain almost every review comment you are likely to get; each exists
because skipping it has already produced a real defect here.

**1. Claims are executed, not asserted.** If a doc says a command produces some output, that
output was captured by running it. A PR that says "this works" without having run it will be
asked to run it.

**2. Configuration is behaviour — render it, don't read it.** Helm templates, CSP headers,
and compose files are code. Reviews expect the *rendered* manifest or the *actual* response
header. New knobs go through `packages/config` and are passed down, never read from the
environment at the point of use.

**3. A test that cannot fail proves nothing.** When you add a regression test, show it
**red** first. If the behaviour was already correct, break the implementation and confirm
the test catches it — then revert.

**4. Integration tests run; they never skip.** CI fails the build if any test is skipped
rather than executed, because a skipped integration test looks identical to a passing one in
a summary.

**5. Honesty beats a clean result.** If a limitation survives your change, name it, assert
it in a test so it cannot be quietly forgotten, and record it in
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

### Mechanics

- **DCO sign-off** on every commit (`git commit -s`). CI rejects PRs without it.
- **A changeset** for any change to a publishable npm package (`@getpharos/sdk`,
  `@getpharos/middleware`, `@getpharos/pdp-spec`): `pnpm changeset`. Docs-only or internal
  PRs take the `no-changeset` label. The Python packages version through their
  `pyproject.toml`; bump them in the same PR as the change.
- **Formatting**: `pnpm format:write` before you push; `pnpm format:check` is a CI gate.
- **Conventional Commits**: `type(scope): summary`, e.g.
  `fix(gateway): preserve non-JSON request bodies`.

## Runtime (Python)

`runtime/python` is the Pharos Runtime: durable, governed execution. Its gates run from the
repository root with `pnpm runtime:check` and in the `runtime` CI job:

```bash
cd runtime/python
python -m ruff check .                              # lint
python -m mypy keel pharos_runtime                  # --strict
lint-imports                                        # layers point downward only
python -m keel._lint.determinism keel               # no nondeterminism bypasses a port
python -m pytest -q                                 # unit + property + chaos
python -m keel.cli regress run --suite tests/regression/suite   # byte-identical replay
```

Two rules are load-bearing for the product and are enforced by those gates:

- **Downward-only imports.** Layers are `substrate → kir → executor → services →
  authoring → adapters`. Nothing imports upward.
- **Nondeterminism only through ports.** No `datetime.now()`, `time.time()`, `random`, or
  `uuid` outside `keel/substrate`; route through the injected `Clock` / `Rng` / `IdGen` or
  replay diverges. An audited exception needs a `# det-ok` comment with a reason.

If you touch the event envelope, serialization, or a node handler, the golden corpus
(`tests/golden`) and the regression suite (`tests/regression/suite`) must still replay
byte-identically; schema changes need an upcaster (see
[`runtime/python/docs/EVENT-SCHEMA.md`](runtime/python/docs/EVENT-SCHEMA.md)).
The runtime talks to the control plane through the Python SDK (`sdks/python`); it has no
HTTP client of its own.

## Pull requests

- Fill in the [PR template](.github/pull_request_template.md).
- Changes touching `packages/core`, `packages/storage`, `packages/identity`, or
  `runtime/python/keel/substrate` require review from a maintainer
  (see [CODEOWNERS](.github/CODEOWNERS)).
- Keep PRs focused on a single concern. Small PRs merge; large PRs rot.

## Dependency updates (Dependabot triage)

Dependabot opens dependency-update PRs weekly (config:
[`.github/dependabot.yml`](.github/dependabot.yml)). **Do not blind-merge them.**

| Category | Policy |
|---|---|
| **Dev-dependency patch/minor** (grouped) | Merge when CI is green. `no-changeset` label. |
| **Runtime-dependency patch/minor** | Merge when CI is green after a skim of the changelog. `no-changeset` label. |
| **Any major (`x.0.0`)** | One PR at a time. Read the migration notes, get the full suite green, make a deliberate decision. Never batch majors. |
| **Trust-path libraries** — `zod`, `jose` | A trust-path change even on a routine bump: full suite green and a written note in the PR describing what on the validation / token-verification path was re-checked. |
| **`apps/console`-only deps** | Patches: merge if green. Majors: close with reason and defer; the console is not on the critical path. |
| **GitHub Actions majors** | Grouped; merge when CI is green. |

Close-with-reason is a valid outcome. Deferring an update is a decision, not a failure —
record why in the PR and, if it should not re-open, add an `ignore` entry.

## Getting help

Thirty minutes stuck → write down what you tried → open an issue or a discussion. Two hours
stuck silently is the only way to actually fail here.
