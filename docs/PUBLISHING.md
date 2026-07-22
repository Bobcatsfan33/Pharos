# Publishing the SDKs

Pharos ships two SDKs from signed, versioned artifacts:

- **`@pharos/sdk`** → npm, with [provenance](https://docs.npmjs.com/generating-provenance-statements).
- **`pharos-sdk`** → PyPI, with [Trusted Publishing](https://docs.pypi.org/trusted-publishers/) (OIDC).

Publishing is automated by [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which runs on a version tag (`v*`) or a manual `workflow_dispatch`. The workflow builds,
typechecks, runs the hermetic SDK tests, and publishes.

## Name availability (checked 2026-07-21)

| Package | Registry | Status |
|---|---|---|
| `pharos-sdk` | PyPI | **Available** — free to claim. |
| `@pharos/sdk` | npm | Package name free; requires owning the npm **org `pharos`** (scoped package). |

## One-time maintainer setup — "what to click"

These are human steps that must be done **before the first publish**. The workflow is inert
until they exist.

### npm (`@pharos/sdk`)

1. **Create the npm org** named `pharos` (<https://www.npmjs.com/org/create>). The scope
   `@pharos` must be owned by an account/org you control.
2. Choose ONE auth method:
   - **Automation token (simplest):** create a *Granular Access* / *Automation* token with
     publish rights to `@pharos/*` (npmjs → Access Tokens). Add it to the repo as the secret
     **`NPM_TOKEN`** (Settings → Secrets and variables → Actions). The workflow reads it as
     `NODE_AUTH_TOKEN`. Provenance still works because the job requests an OIDC `id-token`.
   - **Trusted publishing (no secret):** on npmjs, configure a trusted publisher for
     `@pharos/sdk` pointing at this repo + `release.yml`. Then `NPM_TOKEN` is not needed.
3. Provenance requires the repo to be public and the workflow to have `id-token: write`
   (already set).

### PyPI (`pharos-sdk`)

1. Create the PyPI project by adding a **Pending Trusted Publisher** (you don't upload a first
   release manually): PyPI → *Your projects* → *Publishing* → *Add a pending publisher*:
   - Project name: `pharos-sdk`
   - Owner: `Bobcatsfan33`  ·  Repository: `Pharos`
   - Workflow name: `release.yml`
   - Environment: *(leave blank)*
2. No secret is needed — the `pypi-publish` job authenticates via OIDC (`id-token: write`).

## Cutting a release

The SDK versions live in `packages/sdk-ts/package.json` and `sdks/python/pyproject.toml`
(both `0.1.0` today; bump via Changesets / manually as appropriate). Then:

```bash
git tag -a vX.Y.Z -m "SDKs vX.Y.Z"
git push origin vX.Y.Z          # triggers release.yml
```

Or trigger `release.yml` manually from the Actions tab (`workflow_dispatch`) for the first
publish without minting a new tag.

> ⚠️ **Publishing is irreversible** — npm/PyPI names and versions cannot be reused. The
> workflow was validated with `pnpm --filter @pharos/sdk publish --dry-run` (npm) and
> `python -m build` + `twine check` (PyPI); do a dry run again before the first real publish.

## Verifying a published release

```bash
# npm — provenance
npm view @pharos/sdk        # shows the version + provenance
npm install @pharos/sdk     # from a clean project

# PyPI
pip install pharos-sdk
```

Both registry pages should show the provenance / trusted-publisher attestation once the
first release lands.
