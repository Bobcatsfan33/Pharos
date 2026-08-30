# Keel + Pharos: one governed runtime

Keel is the durable execution engine. Pharos is its policy, human-review, and sealed-evidence
control plane. They are one product at the runtime boundary while remaining independently
deployable services: Keel owns execution state and Pharos owns governance state.

## End-to-end contract

For every runnable node Keel:

1. submits `POST /v1/actions` before it emits `step.scheduled`;
2. binds the request to `keel:authorize:v1:<sha256>` so retries replay one sealed record;
3. appends `governance.decided` with the Pharos record ID, sequence, hash, key ID, verdict,
   risk score, tier, and rule citations;
4. executes only an `allow` or `modify` decision;
5. parks on `escalate` and uses `keel:claim:v1:<sha256>` to reclaim the same approved
   continuation after a crash; and
6. fails before execution on `block`, rejection, a malformed request, or an auth error.

If Pharos is unreachable, Keel appends `governance.unavailable` and parks the run. This
fail-closed behavior is the default. `--pharos-failure-mode fail_open` exists for explicitly
reversible, low-risk deployments, and records the local fallback in the event log.

The action payload contains only explicit `config.pharos.payload` data plus Keel identifiers
and a hash of the node. Prompts, tool arguments, and the rest of `node.config` are not sent
implicitly. This is deliberate data minimization; add policy-visible fields explicitly.

## Configuration

The CLI accepts flags or equivalent environment variables:

| Flag | Environment | Required | Default |
|---|---|---:|---|
| `--pharos-url` | `PHAROS_URL` | yes | — |
| `--pharos-api-key` | `PHAROS_API_KEY` | yes | — |
| `--pharos-tenant` | `PHAROS_TENANT_ID` | yes | — |
| `--pharos-agent-id` | `PHAROS_AGENT_ID` | no | `keel-runtime` |
| `--pharos-deadline-ms` | `PHAROS_DEADLINE_MS` | no | `800` |
| `--pharos-max-retries` | `PHAROS_MAX_RETRIES` | no | `2` |
| `--pharos-failure-mode` | `PHAROS_FAILURE_MODE` | no | `fail_closed` |

The Pharos API key needs `actions:write` and `liability:assert` scopes.

Programmatic usage:

```python
runner = await Runner.open(
    model=model,
    pharos=PharosConfig(
        base_url="https://pharos.example.com",
        api_key="pk_...",
        tenant_id="acme",
    ),
)
```

## Per-step declarations

Every KIR node can declare the action Pharos should govern:

```python
Node(
    id="send",
    type=NodeType.TOOL_STEP,
    tool="email.send",
    config={
        "pharos": {
            "action_type": "email.send",
            "oversight_mode": "human_in_loop",
            "reversibility": "irreversible",
            "financial_amount": 0,
            "currency": "USD",
            "mandate_id": "communications-v2",
            "payload": {"dataClass": "customer", "destination": "external"},
        }
    },
)
```

Tool steps default to `human_in_loop` and `irreversible`; other nodes default to
`autonomous` and `reversible`. Those are conservative declarations, not inferred facts—set
them explicitly for production actions.

When a reviewer chooses `modify`, Pharos may return a `modifiedAction` containing
`payload.keelConfig`. Keel validates it as an object and runs that approved configuration
while retaining the node's original `pharos` declaration for future retries.

## Verification

`tests/unit/test_pharos.py` covers allow, block, unavailable/fail-closed, pending-to-approved
resume, human modification, data minimization, evidence ordering, and the real HTTP wire
contract. Pharos independently tests exact-once action ingestion and replay-safe escalation
claim ownership against Postgres.
