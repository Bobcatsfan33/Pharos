# Publishing the SDKs

Pharos ships two SDKs from signed, versioned artifacts:

- **`@getpharos/sdk`** → npm, with [provenance](https://docs.npmjs.com/generating-provenance-statements).
- **`getpharos`** → PyPI (the Python import name stays `pharos_sdk`), with
  [Trusted Publishing](https://docs.pypi.org/trusted-publishers/) (OIDC).

Both are **live**. Publishing is automated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which runs on a version
tag (`v*`) or a manual `workflow_dispatch`.

> The `pharos` npm scope and PyPI name were taken, so the packages use the `getpharos` scope /
> distribution name. The Python module you import is unchanged: `import pharos_sdk`.

## No-secrets model (read this first)

**There are no publish secrets in this repository, and none may be added.** Both registries
authenticate the release workflow via **OIDC trusted publishing** — the workflow proves its
identity to npm/PyPI directly; there is no `NPM_TOKEN` or `PYPI_API_TOKEN`.

- **npm** is configured with **2FA required** and **tokens disallowed** on `@getpharos/*`. Do
  not add an automation token — it would be rejected, and it violates the posture.
- Any human-only npm operation (e.g. `npm deprecate`) therefore must be run **by the
  maintainer from a 2FA-authenticated machine** — no CI/automation can do it.

## As-built trusted-publisher configuration

Both were configured by the maintainer and have published real releases.

### npm — `@getpharos/sdk`

- Trusted publisher: repository **`Bobcatsfan33/Pharos`**, workflow **`release.yml`**, **no
  environment**, action **`npm publish`** allowed.
- Package settings: **2FA required**, **tokens disallowed**.
- npm OIDC trusted publishing needs **npm ≥ 11.5.1** (Node 22 ships npm 10), so the workflow
  upgrades npm before publishing.

### PyPI — `getpharos`

- Trusted publisher: repository **`Bobcatsfan33/Pharos`**, workflow **`release.yml`**,
  environment **`pharos`**.
- The `pypi-publish` job declares `environment: pharos` — this **must** match the trusted
  publisher, or PyPI rejects the OIDC token.

## Published versions

| Version | npm `@getpharos/sdk` | PyPI `getpharos` |
|---|---|---|
| 0.1.0 | **Broken — deprecated.** Manual first publish via the npm CLI; its `exports` map pointed at raw TypeScript source because `publishConfig.exports` is a **pnpm-only** feature the npm CLI ignores. Do not use. | Fine. |
| 0.1.1 | **Good.** `exports` points at `dist/` directly; published via OIDC trusted publishing. | Fine (version-sync, no functional change). |

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

## Cutting a release

1. Bump the versions: `packages/sdk-ts/package.json` (+ its `CHANGELOG.md`) and
   `sdks/python/pyproject.toml`. Prefer a Changeset for the npm package.
2. Tag and push:

   ```bash
   git tag -a vX.Y.Z -m "SDKs vX.Y.Z"
   git push origin vX.Y.Z          # triggers release.yml
   ```

   Or run `release.yml` from the Actions tab (`workflow_dispatch`).

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
