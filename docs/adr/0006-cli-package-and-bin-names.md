# ADR 0006 — CLI package and command names

- **Status:** Accepted (engineering; no registry publish happens under this ADR — the
  maintainer publishes)
- **Date:** 2026-10-22
- **Tags:** packaging, distribution, adoption

## Context

Phase A2 of the adoption program ships a command-line on-ramp: `npx <package> init && npx
<package> demo` must reach a sealed, verified verdict in under a minute with only Node
installed, and `pipx run <dist> demo` must do the same with only Python. The names had to be
checked on day one.

Measured on 2026-10-22:

| Registry | Name | State |
|---|---|---|
| npm | `pharos` | taken (unrelated, 0.0.1) |
| npm | `pharos-cli` | taken (unrelated, 0.6.0) |
| npm | `@getpharos/cli` | **free** (scope already ours: `@getpharos/sdk` is published) |
| npm | `@getpharos/middleware`, `@getpharos/pdp-spec` | **not published** despite being referenced in docs — a separate truth fix |
| PyPI | `pharos` | taken |
| PyPI | `getpharos` | ours — the Python SDK (import name `pharos_sdk`) |
| PyPI | `pharos-cli`, `pharos-runtime` | free |

One more constraint: `runtime/python` already declares `pharos = "pharos_runtime.cli:main"`
as a console script. It is not published to PyPI, but anyone who `pip install -e`s the runtime
gets a `pharos` command that is the *durable-execution engine's* CLI, not this one.

## Decision

1. **npm package `@getpharos/cli`, bin `pharos`.** Scoped under the organisation we already
   own; the bare bin name is what users type. Fallback if the scope were ever lost:
   `getpharos` (unscoped, free on npm).
2. **Python: the entry point ships inside the existing `getpharos` distribution** as console
   script `pharos`, so `pipx run getpharos demo` works without a second distribution. (A2
   part 4; not in this PR.)
3. **The runtime's `pharos` console script is renamed to `pharos-runtime`** in the same A2
   part-4 PR, keeping `keel` as is. Two of our own packages must not fight over one name on
   PATH; `pharos run` remains the runtime verb in both CLIs, dispatched by the `getpharos`
   entry point when the runtime is installed.
4. **The CLI is one esbuild bundle of the private workspace packages.** They are `private:
   true` and export TypeScript source, so they cannot be dependencies of a published package.
   `fastify`/`@fastify/cors` stay real dependencies. The Postgres, Redis, S3 and KMS SDKs and
   `onnxruntime-node` are imported lazily by their own modules and are **not** dependencies:
   the build refuses to ship if the embedded entry graph imports any of them statically, and
   the install smoke test asserts none of them were installed.

## Consequences

- `npx @getpharos/cli demo` installs the CLI plus fastify's tree and nothing else; the
  Postgres path from the CLI (`pharos serve --backend postgres`, later) tells the user which
  packages to add.
- `createPool` in `@pharos/storage` became async (its only callers already awaited the
  migrations that follow). `AwsKms` is still exported from `@pharos/core`; it just no longer
  loads the SDK at import time.
- Publishing `@getpharos/cli` is a maintainer action under the existing npm trusted-publishing
  setup (`release.yml`), after the tarball smoke in CI is green.
