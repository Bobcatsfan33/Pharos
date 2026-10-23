# Adoption diagnosis — the baseline to beat

**Date:** 2026-10-22 · **Commit measured:** `9c1f14e` (main) · **Host:** Apple Silicon macOS 24.6,
Node 25.9 (engines say ≥ 22), pnpm 10.32.1, Docker Desktop 29.4.3, Python 3.9 system (runtime
needs ≥ 3.11).

This document is the "before" picture for the adoption program (Phases A–E). Every number in it
was measured by running the command, not estimated. It is deliberately unflattering: the goal is
to have something concrete to beat, and to never again ask a first-time developer to trust a
claim they cannot verify in a minute.

## 1. Time-to-first-verdict today

The README quickstart, run literally on a clean clone. "First verdict on screen" means the
`seq 1 payment.transfer -> BLOCK` line from `pnpm demo:durability`.

| Step | Measured | Notes |
|---|---|---|
| `git clone` | 1 s | 759 MB after install; the repo itself is small |
| `pnpm install` (warm store) | 2 s | README's own number (2 s) reproduced |
| `pnpm install` (cold store, `--store-dir` fresh) | 5 s | fast network; expect 20–60 s on a typical connection |
| `pnpm infra:up` — image pulls | **not completable on this host** | see §1.1 — Docker pulls hung for > 7 min twice, across a Docker Desktop restart. The README budgets "about five minutes" for this on a first run. |
| `pnpm infra:up` — containers up + healthy (images cached) | 6 s | Postgres + Redis + MinIO + the runtime viewer container |
| `pnpm demo:durability` → first verdict | 1 s | runs migrations, mints a key, seals 3 records |
| `pnpm demo:durability --verify` | 1 s | cold re-open, chain verify genesis→head |
| `pnpm demo` (four-act story, writes `evidence-bundle.json`) | 1 s | |
| `pnpm verify:bundle evidence-bundle.json` | < 1 s | the one command that needs no infra |
| `pnpm test` (547 tests against real Postgres/Redis/MinIO) | 31 s wall (12.7 s of test time) — **10 failed, 8 skipped** on this host; see §1.2 | |

**Clone-to-first-verdict, images already cached, everything already installed:** **about 12 s of commands** (1 + 2 + 6 + 1 + 1 + 1), plus whatever the pulls cost.
**Clone-to-first-verdict for a genuinely first run:** that number plus the image pulls (README:
~5 min) plus installing Docker Desktop, Node 22+, and pnpm if absent — realistically **10–30
minutes**, and on this host today, **unbounded**, because the pull never finished.

The target is **under 60 seconds with only Node (or only Python) installed**.

### 1.1 What happened with Docker

`docker compose up -d` sat for 7m20s with zero containers created. A direct
`docker pull cgr.dev/chainguard/minio@sha256:4cf48…` produced no output for 40 s; even
`docker pull alpine:3.20` hung. Restarting Docker Desktop did not help. The daemon answered
`docker info` the whole time, so nothing in the README's troubleshooting would have pointed a
developer at the cause. The measured numbers above were obtained by overriding the MinIO image
to an already-cached `minio/minio` (local override only, not committed; MinIO withdrew its
public images in 2026-09, which is why the repo pins Chainguard).

This is the point: **the on-ramp currently depends on three container pulls from two registries,
one of which has already changed once under us.** A developer who hits this at 11 pm closes the
tab.

### 1.2 `pnpm test` is not green after following the README

With the stack from `pnpm infra:up` healthy, `pnpm test` reports **10 failed, 8 skipped, 529
passed**. Every failure and every skip is `ECONNREFUSED 127.0.0.1:8088`: the AWS KMS emulator
(`nsmithuk/local-kms`) that CI starts as an extra `docker run` step is not in
`docker-compose.yml`, and neither the README, `CONTRIBUTING.md`, nor `docs/ONBOARDING.md`
mentions it. CONTRIBUTING says "If `pnpm test` is not fully green on your machine, stop and fix
your environment" — a new contributor cannot, because nothing tells them what is missing.
ONBOARDING's "Expected: 520 control-plane tests with 0 skipped" cannot be reproduced from its
own instructions. (The 2026-08-02 `.env` this host had from an earlier checkout also failed the
config loader — `PHAROS_KMS_KEYSTORE_PASSPHRASE` became required after it was written — so a
returning developer gets a second, different wall.)

## 2. Every step a first-time developer takes before seeing value

Counting from "I have a laptop with nothing on it":

1. Install Node ≥ 22 (README says nothing about the version; `package.json` says `>=22`;
   `docs/ONBOARDING.md` still says ≥ 20).
2. Install pnpm 10 (`corepack enable` or `npm i -g pnpm`); pnpm 10 then prints a scary
   "Ignored build scripts: esbuild, sharp" warning that ONBOARDING has to explain away.
3. Install Docker Desktop (or Engine + Compose) and start it.
4. `git clone` (there is no `npx`, `pip`, `brew`, or `docker run` path to a verdict — only clone).
5. `pnpm install`.
6. `cp .env.example .env` — a 90-line file. Six variables are *required* by the config loader
   even in `PHAROS_ENV=local` (Postgres URL, Redis URL, S3 endpoint/region/bucket, and a ≥16-char
   keystore passphrase). The example ships a placeholder passphrase that the comment tells you to
   replace.
7. `pnpm infra:up` — pull/start Postgres 16, Redis 7, MinIO (Chainguard), and build/start the
   Python runtime viewer container (`runtime` service has a `build:` stanza, so a first run also
   builds a Python image).
8. Wait for `docker compose ps` to report healthy; fixed host ports 5433/6380/9010/9011/8321
   must be free.
9. `pnpm demo:durability` — first verdict.
10. (Optional, but it is where the "wow" actually lives) `pnpm demo` then
    `pnpm verify:bundle evidence-bundle.json`.

For the Python runtime quickstart in the README, add: install Python ≥ 3.11, create a venv,
`pip install -e "runtime/python[viewer]"` from the clone (not from PyPI — `pharos-runtime` is not
published), then `pharos run --mock …`.

To *use* Pharos from an agent (README "Use it from your agent"): additionally start the API
(`pnpm api:dev`), mint a tenant with an admin-token `curl`, copy the plaintext API key out of the
response, export it, and only then run `examples/langgraph-agent.ts` — which imports relative
workspace source, not the published package.

**Prerequisite count for the quickstart: 4** (Node, pnpm, Docker, git). **For the full README: 6**
(+ Python 3.11, + a venv). Target: **1**.

## 3. Prerequisites, precisely

| Prerequisite | Needed for | Could the on-ramp drop it? |
|---|---|---|
| Node ≥ 22 | everything TS | no — this is the one we keep |
| pnpm 10.x | workspace install | yes — `npx @getpharos/cli` needs only npm |
| git | clone | yes — registries |
| Docker Desktop / Engine | Postgres, Redis, MinIO, runtime viewer | yes — embedded mode (SQLite + filesystem + in-process counters) |
| Postgres 16 | operational state, chain head, RLS | yes for the on-ramp; stays as the production path |
| Redis 7 | two rate-limit counters, `/healthz` (the verdict-cache `get/set` is dead code) | yes — in-process counter |
| MinIO with Object Lock | WORM evidence objects; `ensureBucket` fails closed without Object Lock | yes for the on-ramp, labelled honestly: tamper-evident ≠ WORM |
| Python ≥ 3.11 + venv | runtime, runtime tests | not needed for a verdict |
| ~90-line `.env` | config loader | yes — embedded mode needs zero required vars |

## 4. Claims the README asks a developer to trust that they cannot verify in under a minute

Each row is a place where a sceptical reader has to take our word for it. "Verifiable in < 1 min"
means: with the repo cloned and nothing else running, a single command shows it.

| README / doc claim | Can it be verified in < 1 min today? | Why not / what it would take |
|---|---|---|
| "written to WORM storage" (first screen) | No | Needs MinIO with Object Lock running. Nothing in the first screen shows Object Lock. |
| "verifiable by anyone, offline, later" | **Yes**, *if* you already have a bundle — `pnpm verify:bundle evidence-bundle.json` is the strongest moment in the repo and it is buried under three Docker containers and two demo commands. A committed bundle is in the repo root, so `pnpm install && pnpm verify:bundle evidence-bundle.json` actually works in ~10 s. The README does not say so. |
| "545 control-plane tests … run against **real** Postgres / Redis / MinIO" | No | Docker + the full suite (31 s wall (12.7 s of test time) — **10 failed, 8 skipped** on this host; see §1.2). A developer without Docker sees every integration file skip — and cannot tell whether that is normal. |
| "Framework middlewares (LangChain/LangGraph, OpenAI Agents, Anthropic SDK, CrewAI, MS Agent Framework)" | No | `@getpharos/middleware` is **not on npm** (404). Only `@getpharos/sdk` 0.2.0 is published. CrewAI/MS adapters live in the Python SDK, not in the TS package the doc table names. The adapters are structural wrappers; no example imports a real framework. |
| "MCP/tool governance" in "Works today, tested" | Partially | `packages/connectors` has the governance *model* (registry, schema drift, scoped credentials). There is **no MCP transport** — no stdio, no JSON-RPC, no `tools/call` handling, no dependency on the MCP SDK. Nothing a developer can point an MCP client at. |
| "a zero-code HTTP gateway governs agents that import nothing at all" | No | Needs the API running, a tenant, a key, Postgres for held requests, and an upstream. |
| "OPA/Cedar interchange", "signed policy bundles", "governed connectors", "approval policy", "causal evidence graph", "assurance promotion/rollback", "technical control mappings", "open governed-action protocol" | No | Exercised only in `test/capability-breadth.e2e.test.ts` and unit tests. No demo, no command. |
| "Transformer judges are wired and served" | No | Default path is the bag-of-words baseline; ONNX path downloads ~650 MB from GitHub Releases. |
| "Both SDKs are deadline-aware, retry transient failures…" | Partially | TS: `npm install @getpharos/sdk` works. Python: `pip install getpharos` works, but the **Python README quickstart cannot run** — it passes `tenant_id=`/`agent_id=` and omits `liability`, so `validate_submit_input` raises `invalid submit input: tenantId must be a string`. |
| "Pharos Runtime: governed execution included … `pharos run --mock …`" | No | `pharos-runtime` is not on PyPI; needs a clone and an editable install under Python ≥ 3.11. The `pharos` console script it installs is the *runtime's* CLI, so any future `pharos` CLI collides with it on PATH. |
| "Good first issues are labelled and scoped with acceptance criteria" | Yes (and underwhelming) | 8 open good-first-issues; 0 Discussions; 13 open Dependabot PRs, oldest 16 days. |
| `docs/status.md`: "157 TS tests + 10 Python tests green" | Contradiction | README says 545; the suite has 547 today. |
| `CONTRIBUTING.md`: "`pnpm test` … must be green before you branch" / ONBOARDING "0 skipped" | **No** | 10 failures + 8 skips with the documented stack, because the KMS emulator CI runs is undocumented and absent from `docker-compose.yml` (§1.2). |
| `docs/external-verification.md` §3: "Ed25519 over the ASCII bytes of `seal.contentHash`" | Stale | That is the legacy v1 signing message; records are sealed with v2 (`pharos:record-seal:v2\n{seq}\n{prevHash}\n{contentHash}`). The crypto-review package has it right; the verification doc does not. |
| Repo description: "real-time policy verdicts in under 800ms" | Retired in README, not in the GitHub description | README §"On latency" retired the headline; the repo's About text still leads with it. |

Not a claim problem but the same symptom: the README's "Use it from your agent" section shows
`import { PharosClient } from "@getpharos/sdk"` and never shows an install command for either
language. A reader has to find `docs/PUBLISHING.md` to learn the package exists on a registry.

## 5. Structural findings that shape Phase A

These came from reading the code, and they decide the shape of the embedded mode and the CLI.

1. **Storage has no ports.** `packages/storage` exports 13 concrete classes whose constructors
   take a `pg.Pool`. Exactly one real interface exists (`HeldRequestStore`, with an in-memory
   implementation in the gateway). `EvidenceStore.append` is the verdict-and-seal transaction:
   `BEGIN` → `SET LOCAL ROLE pharos_app` → `SELECT … FOR UPDATE` on `tenant_chain_head` → seal
   → **S3 PUT inside the open transaction** → `INSERT action_records` → `UPDATE head` →
   `COMMIT`, rollback on PUT failure, with a reconciler for the inverse failure. There is no
   abstraction point in `buildPlatform` for storage or cache; the precedent to copy is
   `buildSigner`/`buildTsaProvider` (config-discriminated factories) and
   `test/signingConformance.ts` (a provider conformance suite run against two providers).
   Consequence: A1 is two PRs — **ports first** (behaviour-preserving, characterised by the
   existing suite), **then the embedded backend + conformance suite**.
2. **The decision path needs no infrastructure.** `VerdictCascade` depends only on core, judge
   (three committed `*.model.json` files), and policy. Postgres enters only to look up tenant
   policies and mandates; Redis holds two rate-limit counters. An embedded mode is therefore
   honest: it changes where state is written, not how verdicts are made.
3. **The CI skip gate is global.** `ci.yml` fails the build if the vitest JSON report has *any*
   pending test. An embedded suite must never `ctx.skip()`; a Postgres suite running without
   Docker locally will (and does) skip, which is why `pnpm test` without Docker looks broken.
   Phase A needs a `test:embedded` entry that is green with no Docker, and the Postgres suite
   stays exactly as gated.
4. **SQLite: use `node:sqlite`.** It is built into Node (unflagged since 22.13 / 23.4;
   this host runs 25.9), so there is no native build step — `better-sqlite3` would hit pnpm 10's
   "ignored build scripts" default and need `pnpm approve-builds`, which is exactly the friction
   we are removing. The CLI package will declare `engines.node >= 22.13`.
5. **Names.** npm: `@getpharos/cli` is free; `pharos` and `pharos-cli` are taken. PyPI:
   `getpharos` is our SDK; `pharos` is taken; `pharos-runtime` and `pharos-cli` are free. The
   runtime already registers a `pharos` console script. Decision (ADR to follow in A2): the npm
   bin is `pharos` inside `@getpharos/cli`; the Python entry point ships inside the existing
   `getpharos` distribution as `pharos` too, and the runtime's `pharos` script is renamed to a
   subcommand (`pharos run` stays the runtime verb in both) — otherwise two of our own packages
   fight over one name.
6. **Bundle export is a script, not an endpoint.** `evidence-bundle.json` is written by
   `scripts/demo.ts` from in-process platform objects. `pharos export` needs a real export path
   that works over the embedded store and over HTTP.
7. **The repo cannot merge its own PRs.** Branch protection requires one approving review with
   `enforce_admins`, and there is one collaborator. Every PR in this program will be opened
   green and merged through the existing, documented drain procedure (temporarily remove the
   review requirement, merge only green PRs, restore the exact settings), and each phase report
   says so. A second maintainer is the real fix and is a maintainer action.
8. **Three Pharos clients, no shared contract test**: `packages/sdk-ts`, `sdks/python`, and
   `runtime/python/keel/services/pharos.py`. Not a Phase A problem; noted for B3.

## 6. Cold self-review: where does a stranger leave?

Reading the README top to bottom as a developer with a coding agent and a nervous feeling:

1. **Line 1** says "move money, send PHI" — not my problem; I'm worried about `rm -rf` and
   `git push --force`. Twenty percent leave here.
2. **The diagram** is good but it is a diagram. No screenshot, no recording, no verdict I can
   see. Nothing to copy-paste that works without Docker.
3. **Quickstart** opens with `git clone` and `docker compose`. The developer who was going to
   try `npx something` leaves here. Most of the rest leave when the pull takes five minutes
   (or, today, never finishes).
4. **"Status — what is and isn't proven"** is the best paragraph in the README and it is below
   700 words of other content.
5. The one thing that would convince a sceptic in ten seconds — *verify this bundle yourself,
   offline, and then tamper with it and watch it fail* — is reachable from the clone with no
   infrastructure today and is not mentioned until `docs/demo.md`.

## 7. Phase A task list

Branch names follow `adopt-<phase>-<task>-short-name`. One PR per branch; anything over ~600
changed lines is split. Each PR quotes its acceptance criteria as checkboxes.

| Branch | Task | Acceptance criteria (summary) |
|---|---|---|
| `adopt-a-00-diagnosis` | this document + `docs/adoption/metrics.md` | measured numbers only; docs-only (`no-changeset`) |
| `adopt-a-01-storage-ports` | A1 part 1: extract interfaces for the stores `buildPlatform` wires, add `buildStorage(config)` discriminated on `PHAROS_STORAGE_BACKEND` (default `postgres`), type `Platform` against the ports, narrow `Platform.pool`. Behaviour-preserving. | existing suite green and unchanged; Postgres remains the default; no format or transaction change in `EvidenceStore.append` |
| `adopt-a-01-embedded-backend` | A1 part 2: `packages/storage/src/embedded/*` — SQLite (`node:sqlite`) for operational state, chain heads and the record rows; content-addressed, never-overwritten record files on disk; in-process counters; seal-and-append in **one SQLite transaction** with the file fsynced before `COMMIT`; reconcile for the inverse failure, mirroring the WORM reconciler. | storage conformance suite (`test/storageConformance.ts`) runs the same cases against embedded and Postgres; `pnpm test:embedded` green with no Docker and 0 skips; `pnpm test` unchanged |
| `adopt-a-01-embedded-honest-labels` | A1 part 3: config/env wiring (zero required vars in embedded mode), API boot in embedded mode, `docs/LIMITATIONS.md` entry ("tamper-evident and offline-verifiable, not WORM; no RLS backstop; single-process rate limits"), `.env.example` note. | `PHAROS_STORAGE_BACKEND=embedded pnpm api:dev` boots with no Docker; LIMITATIONS entry links to the Postgres/S3 path |
| `adopt-a-02-cli-scaffold` | A2 part 1: `packages/cli` (`@getpharos/cli`, bin `pharos`), ADR for the name, `pharos init` (writes `pharos.yaml`, starts embedded), `pharos demo` (three verdicts + verified chain), terminal output with colour/alignment/truncated hashes | `npx @getpharos/cli init && npx @getpharos/cli demo` on a clean machine with only Node shows three verdicts and a verified chain in < 60 s |
| `adopt-a-02-cli-log-verify-export` | A2 part 2: `pharos log`, `pharos verify [bundle]` (exit 0/1), `pharos export`, with transcripts under `docs/adoption/transcripts/` | each command has a committed transcript produced by running it and a CI job that re-runs it |
| `adopt-a-02-cli-run-serve-policy` | A2 part 3: `pharos run -- <command>`, `pharos serve`, `pharos policy test` | transcripts + CI as above |
| `adopt-a-02-python-cli` | A2 part 4: `pipx run getpharos demo` — a `pharos` entry point in the `getpharos` distribution; resolve the runtime's `pharos` script collision | `pipx run getpharos demo` shows three verdicts and a verified chain in < 60 s with only Python installed |
| `adopt-a-03-readme-first-screen` | A3: one sentence, one recording (< 2 MB under `docs/media/`), one command; architecture, FINRA demo, and status table move below the fold; caveats move to docs and stay linked; "Works with" badges row; fix the stale claims in §4 or file labelled issues | a reader of only the first screen reaches a sealed verdict; nothing above the fold claims what embedded mode cannot demonstrate |
| `adopt-a-04-install-surfaces` | A4: verify `npm install @getpharos/sdk` and `pip install getpharos` from published artefacts on a clean machine (tarball import test in CI, amendment 7(b)); Homebrew tap formula; `docker run ghcr.io/bobcatsfan33/pharos demo`; Dev Container / Codespaces config | each surface has a scheduled CI job and a documented one-line install |

Phase A ends with a re-measured §1, a committed demo transcript, and a cold self-review before
Phase B starts.
