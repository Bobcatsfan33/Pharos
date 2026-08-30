# Onboarding — from clean clone to verified evidence in under 30 minutes

This is a **verified** transcript: every command below was run on a fresh `git clone` with all
untracked state removed (`git clean -xdf`), following the README quickstart literally. If a
step behaves differently for you, that is a bug — please open an issue.

Target: a stranger with the prerequisites installed reproduces this start-to-finish, without
asking anyone anything.

## Prerequisites

| Tool | Version used to verify | Notes |
|---|---|---|
| Node.js | ≥ 20 (verified on 25.x) | `node -v` |
| pnpm | 10.32.1 | `corepack enable` or `npm i -g pnpm@10.32.1` |
| Python | ≥ 3.11 | Pharos Runtime and its tests |
| Docker | Desktop / Engine with `docker compose` | provides Postgres + Redis + MinIO |

No cloud accounts, API keys, or secrets are required for the local quickstart.

## 1. Clone and install

```bash
git clone https://github.com/Bobcatsfan33/Pharos.git
cd Pharos
pnpm install
python3 -m venv runtime/python/.venv
runtime/python/.venv/bin/pip install -e "runtime/python[dev,viewer]"
```

Expected: install completes in seconds. pnpm 10 prints a one-time warning that build scripts
for `esbuild` and `sharp` were **ignored** — this is expected and harmless: esbuild ships a
prebuilt platform binary (so `tsx`/`vitest` work), and `sharp` is only needed by the optional
Next.js console.

```
╭ Warning ─────────────────────────────────────────────────────────────────────╮
│   Ignored build scripts: esbuild@..., sharp@....                              │
│   Run "pnpm approve-builds" to pick which dependencies should be allowed ...  │
╰──────────────────────────────────────────────────────────────────────────────╯
Done in ~2s using pnpm v10.32.1
```

## 2. Start the infrastructure

```bash
pnpm infra:up          # control-plane stores + Pharos Runtime viewer
```

Wait until all three report `healthy`:

```bash
docker compose ps
# pharos-postgres   Up (healthy)
# pharos-redis      Up (healthy)
# pharos-minio      Up (healthy)
# pharos-runtime    Up (healthy)
```

The containers use fixed host ports **5433** (Postgres), **6380** (Redis), and **9010**
(MinIO). If any port is already taken, stop the conflicting service or edit
`docker-compose.yml`.

## 3. Configure the environment

```bash
cp .env.example .env
```

Every value in `.env.example` already matches `docker-compose.yml`, so no edits are needed for
the local quickstart. (The integration tests also self-provide these same defaults, so
`pnpm test` works even before you copy `.env`; `.env` is what the demo and API scripts load.)

## 4. Run the test suite

```bash
pnpm test
PATH="$PWD/runtime/python/.venv/bin:$PATH" pnpm runtime:check
```

Expected: 520 control-plane tests with **0 skipped** plus the complete runtime suite. CI fails
if a control-plane integration test skips:

```
 ✓ test/core.migration.test.ts (5 tests)
 ✓ test/core.signing.test.ts (5 tests)
 ...

 Test Files  74 passed (74)
      Tests  520 passed (520)
```

> Note: `test/integration.causeway.test.ts` is mildly timing-sensitive; on a busy machine it
> can rarely flake. Re-run `pnpm test` and it goes green.

## 5. Prove durability (seal, then cold-restart verify)

```bash
pnpm demo:durability            # submit demo actions, seal records
```

Expected:

```
Provisioned tenant + auditor key (saved to .pharos-demo-auditor-key).

=== Submitting 3 demo actions for tenant "demo-tenant" ===
  seq 0  email.send          -> ALLOW      hash 2ae4a7c5de26…
  seq 1  payment.transfer    -> BLOCK      hash fd38cbb64d75…
  seq 2  crm.update          -> ALLOW      hash d9f8c5848f6f…

Chain head: sequence 2 hash d9f8c5848f6f4494…
Records are now durable in Postgres + WORM. Re-run with --verify to simulate a cold restart.
```

Then simulate a restart and verify the chain survived:

```bash
pnpm demo:durability --verify   # records persist, chain verifies genesis→head
```

Expected output:

```
=== Cold verification for tenant "demo-tenant" (simulated restart) ===
Found 3 persisted records after restart.
Genesis-to-head chain verification: PASS ✅
  records checked: 3
```

## 6. (Optional) Serve the API and verify offline as a third party

`verify:external` fetches the exported bundle from the **running API**, so these run in **two
terminals**:

```bash
# terminal 1 — leave running
pnpm api:dev
#  > Pharos API listening on :4000 (local)
```

```bash
# terminal 2
pnpm verify:external demo-tenant
```

Expected — verification uses `@pharos/core` **only** (no DB, no signer, no platform calls):

```
=== External verification of tenant "demo-tenant" (offline, zero-trust) ===
Fetched 3 records and 1 public keys.
Verifying 3 records with @pharos/core ONLY (no DB, no signer, no platform calls)...

  OK  seq   0  hash:ok sig:ok link:ok
  OK  seq   1  hash:ok sig:ok link:ok
  OK  seq   2  hash:ok sig:ok link:ok

Chain verification: PASS - admissible
```

> Running `pnpm verify:external` **without** `pnpm api:dev` in another terminal fails with
> `ECONNREFUSED` (it cannot reach `http://localhost:4000`). Start the API first.

The optional Next.js console (`pnpm --filter @pharos/console dev`, on `:3000`) needs the
`sharp` build that pnpm skipped in step 1; run `pnpm approve-builds` if you want it. The
console is not required for any of the proofs above.

## 7. Tear down

```bash
pnpm infra:down        # stops containers and removes volumes
```

Local artifacts created by the demo (the encrypted keystore under
`$XDG_DATA_HOME/pharos/keystore` or `~/.local/share/pharos/keystore`,
`.pharos-demo-auditor-key`, and `.env`) are outside the checkout or git-ignored. Keep the
keystore passphrase in an OS keychain or local secret manager, not in shell history.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm test` integration tests fail to connect | infra not up / still starting | `pnpm infra:up`, wait for all three `healthy`, retry |
| Port already in use on infra:up | 5433 / 6380 / 9010 taken | stop the other service or edit `docker-compose.yml` |
| `verify:external` → `ECONNREFUSED` | API not running | start `pnpm api:dev` in another terminal first |
| A single Causeway test flakes | timing sensitivity under load | re-run `pnpm test` |
| Console won't start | `sharp` build was skipped | `pnpm approve-builds` (console is optional) |

## Landing changes (committers)

How a change reaches `main` depends on what it touches — pick the lightest path that works:

- **Docs-only or a small single-file edit** (a roadmap amendment, a README/doc fix): edit the
  file on a fresh branch off `main` and commit it directly — `git checkout -b my-change origin/main`,
  edit, `git commit -s`, `git push`, open the PR. Do **not** route these through a
  patch/transfer round-trip; a dirty working tree or a leftover `git am` session turns a
  one-line docs change into a multi-step recovery (learned the hard way — roadmap §7 amendment 9
  neighbours). Label the PR `no-changeset` when no publishable package changed.
- **Multi-file code changes**: normal branch → PR → review → CI-green → squash-merge, one task
  per PR, no stacking (roadmap §7 amendment 9). Every commit is DCO-signed (`git commit -s`);
  add a changeset when a publishable package (`@getpharos/*`) changes.
- **`.github/workflows/` files**: a GitHub App / automation token **cannot** push workflow
  changes (roadmap §7 amendment 7(c)) — these must be committed by a maintainer with a
  human-scoped token/PAT, as a separate commit if an automated PR needs them.

Before merging any PR: confirm its **base ref is `main`** and, after landing a sprint, confirm
`main` actually contains the changes (roadmap §7 amendment 9). "Automatically delete head
branches" is on, so merged branches clean themselves up.
