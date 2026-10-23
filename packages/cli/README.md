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

`pharos <command> --help` lists options.

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

## Links

- Repository, architecture, limitations: https://github.com/Bobcatsfan33/Pharos
- TypeScript SDK: `npm install @getpharos/sdk` · Python SDK: `pip install getpharos`
