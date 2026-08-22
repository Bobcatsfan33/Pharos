# Keel + Pharos: governed durable execution

[Keel](https://github.com/Bobcatsfan33/keel) is Pharos's first-party durable execution plane.
Pharos decides whether an action may happen and seals that decision; Keel owns the actual
step lifecycle, crash recovery, model/tool effect replay, budgets, and execution outcome.

The integration keeps both services independently scalable while presenting one runtime
contract:

```text
Keel runnable step
  -> Pharos POST /v1/actions (stable authorization idempotency key)
     -> allow/modify: sealed record -> Keel evidence event -> execute
     -> block: sealed refusal -> Keel fails before step.started
     -> escalate: sealed record + review handle -> Keel durable pause
        -> human approve/modify/reject (sealed human verdict)
        -> Keel resume -> replay action -> stable continuation claim -> execute/fail
```

## Reliability invariants

- The authorization idempotency key is derived from tenant, Keel run ID, and node ID. A
  network retry or crash replays the same Pharos record rather than sealing a duplicate.
- The continuation `claimId` is separately derived from the same durable identity. The first
  claimant owns the approval; the same owner can recover after a crash; another owner is
  refused.
- Keel emits `governance.decided` before `step.scheduled`, including record ID, sequence,
  content hash, signing key ID, risk score, tier, and citations. `step.completed` or
  `step.failed` later supplies the execution outcome in that same ordered event stream.
- Keel fails closed on Pharos network/server failure by appending
  `governance.unavailable` and `run.paused`. An explicit fail-open option is available for
  deployments that accept unsealed reversible actions.
- Prompts and arbitrary node configuration are not transmitted implicitly. Only a node's
  explicit `pharos.payload` plus Keel identifiers and a node hash cross the boundary.

## Run it

Start Pharos using the [local onboarding guide](ONBOARDING.md), create a tenant API key with
`actions:write` and `liability:assert`, and expose the API on port 4000. In a Keel checkout:

```bash
export PHAROS_URL=http://localhost:4000
export PHAROS_API_KEY=pk_...
export PHAROS_TENANT_ID=acme

keel run --mock examples/pharos_governed.py --run-id governed-demo
keel show governed-demo
```

If a policy escalates the `publish` step, resolve it in Pharos and run:

```bash
keel resume governed-demo --mock
```

The resume resubmits the identical authorization key, observes the human decision, claims
with the identical continuation identity, and executes only the unfinished step.

## Human modification

A reviewer may supply a Pharos `modifiedAction` with `payload.keelConfig`. Keel validates
that value as an object and uses it as the executable node configuration while preserving
the original `pharos` declaration. This makes the Pharos `modify` feature operational rather
than merely advisory.
