# Adoption metrics

Real measurements only. Each row names the commit it was measured on and how. Estimates are not
allowed in this file; if a number has not been measured it says "not measured".

## Time to first sealed verdict

| Date | Commit | Path | Host | Result | How measured |
|---|---|---|---|---|---|
| 2026-10-22 | `9c1f14e` | README quickstart (`clone` → `pnpm install` → `cp .env.example .env` → `pnpm infra:up` → `pnpm demo:durability`) | macOS/arm64, Node 25.9, pnpm 10.32.1, Docker Desktop 29.4.3, warm pnpm store, container images **already cached** | **~12 s of commands**; first-run image pulls **did not complete** on this host (> 7 min, twice) | `scripts` in `docs/adoption/00-diagnosis.md` §1; stopwatch via `date +%s` around each command |
| — | — | `npx @getpharos/cli init && npx @getpharos/cli demo` | clean machine, Node only | not measured (does not exist yet) | target: < 60 s |
| — | — | `pipx run getpharos demo` | clean machine, Python only | not measured (does not exist yet) | target: < 60 s |

## Prerequisites for the quickstart

| Date | Commit | Count | List |
|---|---|---|---|
| 2026-10-22 | `9c1f14e` | **4** | git, Node ≥ 22, pnpm 10, Docker (Postgres + Redis + MinIO + runtime viewer); +2 for the full README (Python ≥ 3.11, a venv) |

Target: 1 (Node) or 1 (Python).

## Lines of code to govern an existing agent, per framework

Measured as the lines a developer adds at the wrap site, with a client already constructed.

| Date | Commit | LangChain/LangGraph | OpenAI Agents | Anthropic SDK | CrewAI | MS Agent Framework | Notes |
|---|---|---|---|---|---|---|---|
| 2026-10-22 | `9c1f14e` | 1 (`langchainTool(client, opts, fn)`) + ~8 for real risk metadata via `mapAction` | 1 + ~8 | 1 (`anthropicToolHandlers`) — no `mapAction` hook, so every tool gets the fail-closed default liability | 1 (Python, returns a dict, not a CrewAI tool) | 1 (Python, returns a dict) | plus 2 imports and a 5-line `PharosClient` that needs a running API, a tenant, and an API key; **`@getpharos/middleware` is not on npm**, so none of the TS numbers are reachable from a registry |

Target: one line, defaulting to embedded mode, reachable from the published package.

## Install surfaces live and CI-verified

| Surface | 2026-10-22 (`9c1f14e`) | Target |
|---|---|---|
| npm `@getpharos/sdk` | published 0.2.0; **no CI job installs the published tarball** | live + scheduled CI |
| npm `@getpharos/middleware` | **not published** (404) despite docs naming it | live + scheduled CI |
| npm `@getpharos/pdp-spec` | **not published** (404) | live + scheduled CI |
| npm `@getpharos/cli` | does not exist (name free) | live + scheduled CI |
| PyPI `getpharos` | published 0.2.0; README example cannot run; no console script | live + scheduled CI, `pipx run getpharos demo` |
| PyPI `pharos-runtime` | not published (gated on `PHAROS_RUNTIME_PYPI_ENABLED`) | — (not an on-ramp surface) |
| Homebrew | none | tap formula |
| Docker `ghcr.io/bobcatsfan33/pharos-api` | image published on tags, signed, SBOM; **no `demo` entrypoint** | `docker run … demo` one-liner |
| Codespaces / Dev Container | none | "Open in Codespaces" to a verdict |
| Claude Code hook | none | `pharos init --claude-code` |
| MCP registry | none (no MCP transport exists) | `pharos mcp` proxy listed |
| GitHub Marketplace | none | `pharos-verify`, `pharos-govern` actions |

Count live and CI-verified: **0 of 8 target surfaces** (npm SDK is live but not CI-verified post-publish).

## Policy packs with passing fixtures

| Date | Commit | Count | Packs |
|---|---|---|---|
| 2026-10-22 | `9c1f14e` | **0** fixture-backed packs; 2 code-only packs (`finra` v2, `hipaa` v2 as TypeScript constants, no on-disk format, no should-allow/should-block fixtures) | target: 8 at launch |

## Repo health

| Date | Commit | Open PRs > 14 days | Unlabelled issues | good-first-issue | Discussions | Stars / forks |
|---|---|---|---|---|---|---|
| 2026-10-22 | `9c1f14e` | **2** (#264 16 d, #269 8 d is under; 13 Dependabot PRs open total, oldest 2026-10-06) | 0 of 16 open issues unlabelled (all carry `tracking`/`good first issue`/phase labels; none carry the planned `policy-pack`/`integration`/`docs`/`trust-core` taxonomy) | **8** (target ≥ 20) | **disabled** | 3 / 1 |

## Weekly downloads

Recorded from the registry dashboards after launch; not measured before.

| Week | npm `@getpharos/sdk` | npm `@getpharos/cli` | PyPI `getpharos` | Stars | Forks | External contributors |
|---|---|---|---|---|---|---|
| — | not measured | — | not measured | 3 | 1 | 1 (#58, one external PR to date) |
