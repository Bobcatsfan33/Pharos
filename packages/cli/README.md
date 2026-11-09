# @getpharos/cli

Real-time policy verdicts for AI agents, with a signed, hash-chained evidence record of every
decision. One command, nothing to install but Node ≥ 22.13:

```bash
npx @getpharos/cli init && npx @getpharos/cli demo
```

Three governed actions — one allowed, one **blocked** by a mandate limit (Tier 1, cited rule
`mandate-limit-exceeded`), one **escalated** by the FINRA pack (Tier 3, cited rule
`finra-3110-funds-movement`) — each sealed into a local chain, the chain verified genesis→head,
and an `evidence-bundle.json` written that anyone can check offline:

```bash
npx @getpharos/cli verify evidence-bundle.json     # exit 0 = PASS, 1 = FAIL
```

Change one character inside any record and run it again.

## Commands

| Command | What it does |
|---|---|
| `pharos init` | writes `pharos.yaml`, creates `.pharos/` (SQLite + record files + local keystore), seals the tenant's Ed25519 key |
| `pharos demo` | the three verdicts above, verified and exported |
| `pharos log` | the sealed chain: sequence, verdict, tier, action, cited rule, hash |
| `pharos verify [bundle]` | every hash, signature, chain link and trusted-time anchor; fully offline with a bundle, or the local chain without one |
| `pharos export` | write the evidence bundle (records, public keyset, TSA keyset, anchors — never secrets) |
| `pharos run -- <cmd>` | govern a shell command: verdict, sealed record, then execute — or block (exit 2) / hold (exit 3) |
| `pharos serve` | the Pharos API over embedded storage on 127.0.0.1:4000, with an API key for the project tenant |

`pharos <command> --help` lists options.

### Policy packs

`pharos.yaml` lists the shipped packs a project is governed by. `pharos init` selects only
**`coding-agent-safety`** — destructive filesystem operations, force-pushes to protected
branches, reads of `.env`/SSH/cloud credentials, outbound transfer of local files, registry
publishes, and destructive cloud operations, each with a cited rule. The regulation packs
(`finra`, `hipaa`) are opt-in: their Tier-3 judges are bag-of-words models tuned for
communications and payments and will escalate ordinary shell commands. `pharos demo` adds
`finra` for its payments story.

```bash
pharos run -- git push --force origin main   # BLOCK   cited cas-git-force-push-protected, exit 2
pharos run -- rm -rf build                   # ESCALATE held, cited cas-rm-recursive, exit 3
pharos run -- pnpm test                      # ALLOW   runs; exit code is pnpm's
```

Every `run` seals its record **before** anything executes. `pharos serve` starts the same API
the production deployment runs (`POST /v1/actions`, `/healthz` reports the storage posture)
over the project's embedded storage and prints an API key for SDKs and middlewares.

## What embedded storage guarantees — and does not

The CLI runs Pharos's **embedded** backend: operational state and chain heads in one SQLite
file (`node:sqlite`), every sealed record also written as a content-addressed, never-overwritten
file, all under `.pharos/`. The verdict-and-seal invariant holds exactly as on the production
path: the record is sealed and durably written in the same transaction that returns the verdict.

It is **tamper-evident and offline-verifiable. It is not WORM.** Anyone with write access to
`.pharos/` can delete or replace files; the chain, the seals and `pharos verify` will show it,
but nothing prevents it. The keystore passphrase is generated into `.pharos/keystore.passphrase`
(mode 0600) so the on-ramp needs zero configuration — a development posture. For retention
guarantees, database-level tenant isolation and HSM-backed keys, run the Postgres + S3 Object
Lock + AWS KMS path described in the
[repository](https://github.com/Bobcatsfan33/Pharos/blob/main/docs/LIMITATIONS.md).

The Tier-3 judges on this path are the honest linear baseline (bag-of-words logistic models,
defeated by paraphrase); the transformer judges are a separate, opt-in download.

## Docker

The signed API image carries this CLI, so the demo also runs with nothing installed but Docker:

```bash
docker run --rm ghcr.io/bobcatsfan33/pharos-api:<tag> demo
```

The image is published **only on release tags** (`v*`, signed by `image.yml`); use a tag from
the [releases page](https://github.com/Bobcatsfan33/Pharos/releases). The demo runs embedded
storage inside the container — ephemeral, tamper-evident, not WORM — and `docker run --rm
<image> pharos --version` reaches any other command.

## Links

- Repository, architecture, limitations: https://github.com/Bobcatsfan33/Pharos
- TypeScript SDK: `npm install @getpharos/sdk` · Python SDK: `pip install getpharos`
- Every install surface, its status today and how it is verified:
  https://github.com/Bobcatsfan33/Pharos/blob/main/docs/adoption/install-surfaces.md
