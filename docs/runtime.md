# Pharos Runtime: governed durable execution

Pharos Runtime is the first-party durable execution engine shipped in this repository under
[`runtime/python`](../runtime/python). The Pharos control plane decides whether an action may
happen and seals that decision; the runtime owns step lifecycle, crash recovery, model/tool
effect replay, budgets, and execution outcomes.

The control plane and runtime retain independent scaling and failure boundaries while sharing
one release, command-line interface, test suite, and product contract:

```text
Pharos Runtime step
  -> Pharos POST /v1/actions (stable authorization idempotency key)
     -> allow/modify: sealed record -> runtime evidence event -> execute
     -> block: sealed refusal -> fail before step.started
     -> escalate: sealed record + review handle -> durable pause
        -> human approve/modify/reject (sealed human verdict)
        -> pharos resume -> replay action -> stable continuation claim -> execute/fail
```

## Reliability invariants

- The authorization idempotency key is derived from tenant, run ID, and node ID. A
  network retry or crash replays the same Pharos record rather than sealing a duplicate.
- The continuation `claimId` is separately derived from the same durable identity. The first
  claimant owns the approval; the same owner can recover after a crash; another owner is
  refused.
- The runtime emits `governance.decided` before `step.scheduled`, including record ID, sequence,
  content hash, signing key ID, risk score, tier, and citations. `step.completed` or
  `step.failed` later supplies the execution outcome in that same ordered event stream.
- The runtime fails closed on Pharos network/server failure by appending
  `governance.unavailable` and `run.paused`. An explicit fail-open option is available for
  deployments that accept unsealed reversible actions.
- Prompts and arbitrary node configuration are not transmitted implicitly. Only a node's
  explicit `pharos.payload` plus runtime identifiers and a node hash cross the boundary.

## Run it

Start Pharos using the [local onboarding guide](ONBOARDING.md), create a tenant API key with
`actions:write` and `liability:assert`, and expose the API on port 4000. From this repository:

```bash
export PHAROS_URL=http://localhost:4000
export PHAROS_API_KEY=pk_...
export PHAROS_TENANT_ID=acme

python3 -m pip install -e "runtime/python[viewer]"
pharos run --mock runtime/python/examples/pharos_governed.py --run-id governed-demo
pharos show governed-demo
```

If a policy escalates the `publish` step, resolve it in Pharos and run:

```bash
pharos resume governed-demo --mock
```

The resume resubmits the identical authorization key, observes the human decision, claims
with the identical continuation identity, and executes only the unfinished step.

The root CI runs the runtime lint, strict typing, import-boundary checks, complete test suite,
determinism lint, performance gates, and crash soak. It then runs
[`scripts/e2e-runtime.ts`](../scripts/e2e-runtime.ts) against real Postgres, Redis, MinIO,
KMS, the Pharos HTTP API, and the in-repository `pharos` CLI. It requires two sealed
authorization records, one sealed human verdict, two `governance.decided` events, two
durable `step.completed` outcomes, and zero skipped infrastructure tests.

## Human modification

A reviewer may supply a Pharos `modifiedAction` with `payload.keelConfig`. The runtime validates
that value as an object and uses it as the executable node configuration while preserving
the original `pharos` declaration. This makes the Pharos `modify` feature operational rather
than merely advisory.

The `keel` command remains an executable compatibility alias for existing users. New
documentation and installations use the `pharos` command and `pharos-runtime` distribution.
