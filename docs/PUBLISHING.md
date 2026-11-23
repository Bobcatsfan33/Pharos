# Publishing Pharos

Pharos ships six artifacts from signed, versioned builds:

| Artifact | Registry | On the registry today |
|---|---|---|
| **`@getpharos/pdp-spec`** | npm | **No.** Never published. |
| **`@getpharos/sdk`** | npm, with [provenance](https://docs.npmjs.com/generating-provenance-statements) | Yes, `0.2.0`. Installs clean. |
| **`@getpharos/middleware`** | npm | **No.** Never published. |
| **`@getpharos/cli`** | npm | **No.** Never published, so the README's `npx @getpharos/cli` line does not work outside this repository. |
| **`getpharos`** | PyPI, [Trusted Publishing](https://docs.pypi.org/trusted-publishers/) (OIDC). Python import name stays `pharos_sdk` | Yes. |
| **`pharos-runtime`** | PyPI wheel + signed `ghcr.io/.../pharos-runtime` image | Wheel not published; PyPI publication waits on its pending trusted publisher. |

Registry state verified 2026-11-23 against npmjs.org. The repository is deliberately ahead of
the registries — being unpublished says nothing about whether a published version is healthy,
and `pnpm release:dry-run` reports the two separately.

The SDK registries are **live**. Runtime artifacts and images are automated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml). An exact stable tag
(`vMAJOR.MINOR.PATCH`) or an explicit manual `workflow_dispatch` publishes the SDKs. A semver
prerelease tag such as `v0.3.0-rc.1` deliberately skips both irreversible registry jobs and is
reserved for publishing the signed API assessment image through `image.yml`.

> The `pharos` npm scope and PyPI name were taken, so the SDKs use the `getpharos` scope /
> distribution name. The runtime uses the available `pharos-runtime` distribution name.

## No-secrets model (read this first)

**There are no publish secrets in this repository, and none may be added.** Both registries
authenticate the release workflow via **OIDC trusted publishing** — the workflow proves its
identity to npm/PyPI directly; there is no `NPM_TOKEN` or `PYPI_API_TOKEN`.

- **npm** is configured with **2FA required** and **tokens disallowed** on `@getpharos/*`. Do
  not add an automation token — it would be rejected, and it violates the posture.
- Any human-only npm operation (e.g. `npm deprecate`) therefore must be run **by the
  maintainer from a 2FA-authenticated machine** — no CI/automation can do it. The **first**
  publish of a brand-new package name is one of those operations, for a registry reason
  explained under [Publish order](#publish-order-read-before-any-first-publish). It is still
  token-free: an interactive 2FA publish, not an automation credential.

## As-built trusted-publisher configuration

Both were configured by the maintainer and have published real releases.

### npm — `@getpharos/sdk`

- Trusted publisher must be repository **`Bobcatsfan33/Pharos`**, workflow **`release.yml`**,
  environment **`production-release`**, action **`npm publish`** allowed. The original no-environment
  publisher must be replaced before the next release; the workflow now fails closed at the protected
  environment boundary until that registry-side change is complete.
- Package settings: **2FA required**, **tokens disallowed**.
- npm OIDC trusted publishing needs **npm ≥ 11.5.1** (Node 22 ships npm 10), so the workflow
  upgrades npm before publishing.

### PyPI — `getpharos`

- Trusted publisher: repository **`Bobcatsfan33/Pharos`**, workflow **`release.yml`**,
  environment **`pharos`**.
- The `pypi-publish` job declares `environment: pharos` — this **must** match the trusted
  publisher, or PyPI rejects the OIDC token.

### PyPI — `pharos-runtime`

The workflow always builds, tests, smoke-installs, and retains the runtime wheel. To enable
registry publication, configure a PyPI pending trusted publisher for repository
`Bobcatsfan33/Pharos`, workflow `release.yml`, environment `pharos`, then set the repository
variable `PHAROS_RUNTIME_PYPI_ENABLED=true`. No token or repository secret is permitted.

## Published versions

| Version | npm `@getpharos/sdk` | PyPI `getpharos` |
|---|---|---|
| 0.1.0 | **Broken — deprecated.** Manual first publish via the npm CLI; its `exports` map pointed at raw TypeScript source because `publishConfig.exports` is a **pnpm-only** feature the npm CLI ignores. Do not use. | Fine. |
| 0.1.1 | **Good.** `exports` points at `dist/` directly; published via OIDC trusted publishing. | Fine (version-sync, no functional change). |
| 0.2.0 | **Good.** No dependencies; verified installing clean from a fresh project on 2026-11-23. | n/a (PyPI `getpharos` is on its own version line, currently 0.3.0). |

The manual 0.1.0 npm publish is history — we keep immutable registry history (deprecate, never
unpublish). 0.1.0 has been deprecated on npm with a pointer to `>= 0.1.1`.

## Packaging invariant (do not regress)

The publishable packages (`@getpharos/sdk`, `@getpharos/middleware`, `@getpharos/pdp-spec`)
set `exports` → `./dist` directly (compiled JS + `.d.ts`), each with a `files` field so the
tarball ships only `dist` + `src`. There are **no tsconfig `paths`**, so cross-package
typechecking resolves imports through `exports` — which means **`dist` must exist before
`pnpm -r typecheck`**. Both CI (`ci.yml` test job) and `release.yml` therefore run
`pnpm build:publishable` **before** typecheck. Do not reorder these.

> Lesson (S2-T1b): never rely on `publishConfig.exports` — it is a pnpm-only override that the
> npm CLI silently ignores. Point `exports` at `dist/` in the manifest itself.

## Publish order (read before any first publish)

The order is a **dependency order**, declared once in
[`scripts/release-order.sh`](../scripts/release-order.sh) and enforced by
[`scripts/release-publish.sh`](../scripts/release-publish.sh), which refuses to publish any
package whose `@getpharos/*` dependencies do not already resolve on npm.

| # | Artifact | Depends on | Why it is here |
|---|---|---|---|
| 1 | `@getpharos/pdp-spec` | — | The wire vocabulary. Nothing in the workspace precedes it. |
| 2 | `@getpharos/sdk` | `@getpharos/pdp-spec` | Since the single-schema-source change the SDK imports the spec; `0.2.0` predates that and has no dependencies, which is why it still installs. |
| 3 | `@getpharos/middleware` | `@getpharos/sdk` | Wraps the SDK's `submit` for the framework adapters. |
| 4 | `@getpharos/cli` | — (bundled) | An esbuild bundle of the workspace, so it has no `@getpharos/*` dependency; it goes last because it is the artifact users are told to run and should not exist before the libraries it demonstrates. |
| 5 | `getpharos` (PyPI) | — | The Python SDK. |
| 6 | `pharos-runtime` (PyPI) | `getpharos` | Imports `pharos_sdk`, so its wheel cannot install until the SDK is on PyPI. |

Publishing out of order is not recoverable: the dependency range is baked into the published
tarball, and a name plus version can be deprecated but never reused.

### The first publish of a new name is a maintainer action, not CI

npm attaches a trusted publisher to an **existing** package's settings, and has no
pending-publisher equivalent to PyPI's ([npm/cli#8544](https://github.com/npm/cli/issues/8544)).
A name that has never been published therefore has nowhere to configure OIDC, so CI cannot make
its first publish. This does not weaken the no-secrets posture: the first publish is an
interactive, 2FA-authenticated `npm publish` by the maintainer, and no token is created or
stored anywhere.

For each of `@getpharos/pdp-spec`, `@getpharos/middleware` and `@getpharos/cli`, in the order
above:

```bash
# 1. Rehearse everything first. Proves the whole chain against a throwaway registry.
pnpm release:dry-run -- --local-registry

# 2. Pack the TARBALL and publish THAT — never `npm publish` from the package directory,
#    which uploads `workspace:^` verbatim and produces a package nobody can install.
( cd packages/pdp-spec && pnpm pack --pack-destination /tmp )
npm publish /tmp/getpharos-pdp-spec-*.tgz --access public   # prompts for 2FA

# 3. Confirm a consumer can actually install it, from a clean directory.
cd "$(mktemp -d)" && npm init -y >/dev/null && npm install @getpharos/pdp-spec
```

Then, on npmjs.com, for that package: add the trusted publisher (repository
`Bobcatsfan33/Pharos`, workflow `release.yml`, environment `production-release`), set **2FA
required** and **tokens disallowed**, and set the matching repository variable to `true` so CI
takes over the next release:

| Artifact | Repository variable |
|---|---|
| `@getpharos/pdp-spec` | `PHAROS_NPM_PDP_SPEC_ENABLED` |
| `@getpharos/sdk` | `PHAROS_NPM_SDK_ENABLED` |
| `@getpharos/middleware` | `PHAROS_NPM_MIDDLEWARE_ENABLED` |
| `@getpharos/cli` | `PHAROS_NPM_CLI_ENABLED` |
| `pharos-runtime` | `PHAROS_RUNTIME_PYPI_ENABLED` |

A variable that is not `true` makes `release-publish.sh` skip that package **loudly**. npm also
requires a newly created trusted publisher to complete a successful publish within two days, or
the configuration has to be recreated.

## Rehearsing a release

```bash
pnpm release:dry-run                      # against npmjs.org
pnpm release:dry-run -- --local-registry   # against a throwaway verdaccio, full chain
```

Every artifact is checked twice and the two results are never interchangeable:

- **registry** — does the version already on the registry still install? A failure is a
  `REGRESSION`: users are affected right now.
- **local** — does the artifact built from this tree pack, install and import? A failure is
  `FAILED` if the artifact is wrong, or `BLOCKED` if it only needs a dependency that has not
  been published yet.

`BLOCKED` is the normal state before a first publish. Conflating it with `REGRESSION` is how
[#344](https://github.com/Bobcatsfan33/Pharos/issues/344) was first filed wrongly.

The `--local-registry` run is the one that proves the order: each package is published to the
throwaway registry only after it installs, so the next package has to resolve it for real. The
Python half does the same with a wheelhouse of the distributions already proven in that run.

## Cutting a release

1. Version the npm packages from their changesets — never by hand:

   ```bash
   pnpm changeset version   # bumps package.json + CHANGELOG.md, consumes .changeset/*.md
   ```

   The Python distributions are not managed by changesets; bump
   `sdks/python/pyproject.toml` and `runtime/python/pyproject.toml` to match.
2. Rehearse: `pnpm release:dry-run -- --local-registry` must exit 0.
3. Create and push an exact stable tag:

   ```bash
   git tag -a vX.Y.Z -m "SDKs vX.Y.Z"
   git push origin vX.Y.Z          # triggers release.yml
   ```

   Or run `release.yml` from the Actions tab (`workflow_dispatch`). Both routes must pass the
   protected deployment environments and an independent approval before registry publication.

Do not use a prerelease tag to publish SDKs. `vX.Y.Z-rc.N` is an image-only release-candidate
channel used by independent assessors and production-topology exercises. The release workflow
classifies it and exits successfully with both SDK publication jobs skipped.

> ⚠️ **Publishing is irreversible** — npm/PyPI names and versions cannot be reused. Every
> release check MUST include **installing the packed tarball and importing it**, not just
> building it (that is how the 0.1.0 broken-`exports` bug slipped through):
>
> ```bash
> # npm
> ( cd packages/sdk-ts && pnpm pack --pack-destination /tmp )
> cd $(mktemp -d) && npm init -y >/dev/null && npm i /tmp/getpharos-sdk-*.tgz
> node --input-type=module -e "import { PharosClient } from '@getpharos/sdk'; console.log(typeof PharosClient)"
>
> # PyPI
> ( cd sdks/python && python -m build && twine check dist/* )
> ```

## Verifying a published release

```bash
npm view @getpharos/sdk        # version + provenance attestation
npm install @getpharos/sdk     # from a clean project (>= 0.1.1)

pip install getpharos          # Python import stays: import pharos_sdk
```

Both registry pages show the provenance / trusted-publisher attestation.
