# Install surfaces

Every way to get from nothing to a verified Pharos chain, with its status **today** and the
job that proves it. Nothing here claims more than the named check exercises. The daily proof is
[`.github/workflows/install-surfaces.yml`](../../.github/workflows/install-surfaces.yml)
(cron `23 6 * * *`, also on demand); "live" means a stranger can run the install column right now.

| Surface | Status today | One-line install | How it is verified |
|---|---|---|---|
| TypeScript SDK (`@getpharos/sdk`, npm) | **live** — 0.2.0 published via OIDC trusted publishing | `npm install @getpharos/sdk` | `npm-sdk` job: installs `@latest` into an empty project, asserts `PharosClient` is exported |
| Python SDK (`getpharos`, PyPI; import `pharos_sdk`) | **live** — 0.2.0 published via trusted publishing | `pip install getpharos` | `pypi-sdk` job: installs on Python 3.11, imports `PharosClient`, `govern_tool`, `PharosBlockedError` |
| CLI (`@getpharos/cli`, npm) | **pending publish** — a maintainer action (`docs/PUBLISHING.md`); not on npm yet | `npx @getpharos/cli init && npx @getpharos/cli demo` | `cli-tarball` job (always): packs the tarball, npm-installs it into an empty project, runs every command ([`scripts/cli-smoke.sh`](../../scripts/cli-smoke.sh)); `npm-cli` job runs the `npx` line against the registry once the maintainer sets the repo variable `PHAROS_CLI_PUBLISHED=true`, and fails if init+demo exceeds 60 s |
| Docker demo (`ghcr.io/bobcatsfan33/pharos-api`) | **built on release tags** — the `demo` entrypoint is in the Dockerfile; the image exists on GHCR only for `v*` tags signed by `image.yml` | `docker run --rm ghcr.io/bobcatsfan33/pharos-api:<tag> demo` | `docker-demo` job: builds the image from the checkout and runs `demo` (on `workflow_dispatch`, or daily once `PHAROS_CLI_PUBLISHED=true`); `image.yml` keeps the read-only / non-root / no-build-tooling assertions |
| GitHub Codespaces | **live from this PR** — [`.devcontainer/devcontainer.json`](../../.devcontainer/devcontainer.json) builds the CLI on create | Open the repo in a Codespace, then `pnpm pharos init && pnpm pharos demo` | Not exercised by CI (needs a Codespace); the same commands are what `cli-tarball` runs from the packed tarball |
| Homebrew (`brew install pharos`) | **draft** — [`deploy/homebrew/pharos.rb`](../../deploy/homebrew/pharos.rb) cannot be installed until the CLI is on npm and the tap repo `Bobcatsfan33/homebrew-pharos` exists | *(none yet)* | Not verified; the formula header lists the exact maintainer steps |

What every surface runs is the **embedded** backend: SQLite plus content-addressed record files
under `.pharos/` (or `/tmp/.pharos` inside the Docker demo, which is ephemeral). It is
tamper-evident and offline-verifiable; it is **not** WORM — see
[`packages/cli/README.md`](../../packages/cli/README.md).
