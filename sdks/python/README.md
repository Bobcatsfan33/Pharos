# getpharos

The Python SDK for [Pharos](https://github.com/Bobcatsfan33/Pharos) — the trust control
plane for enterprise AI agents.

Submit an agent action to Pharos **before it executes** and receive a policy verdict
(`allow` / `block` / `modify` / `escalate`) plus a cryptographically sealed evidence record —
two outputs of one transaction. The client honors the verdict deadline, retries transient
failures, and falls back to a safe local default if the platform is unreachable.

The SDK is **dependency-free** (Python standard library only) so it installs anywhere.

## Install

```bash
pip install getpharos
```

Requires Python 3.9+.

## Quickstart

```python
from pharos_sdk import PharosClient

client = PharosClient(
    base_url="https://pharos.example.com",
    api_key="pk_...",
    deadline_ms=800,
    local_fail_mode="fail_closed",  # used only when reversibility is unknown
)

result = client.submit(
    tenantId="acme",
    action={"type": "payment.transfer", "agentId": "billing-agent",
            "payload": {"amount": 30000}},
    liability={"mandate": None, "oversightMode": "autonomous",
               "blastRadius": {"financialAmount": 30000, "currency": "USD",
                               "reversibility": "irreversible"},
               "modelMetadata": None},
)

verdict = result["verdict"]
if verdict["decision"] == "block":
    raise RuntimeError(verdict["ruleCitations"][0]["description"])
# "allow" / "modify": proceed; "escalate": see workflow continuation below.
```

`submit()` takes the wire fields as keyword arguments — camelCase `tenantId`, `action`
(`type`, `agentId`, optional `payload`), `liability` (`oversightMode`, `blastRadius` with
`reversibility`), and optional `mandateId` / `idempotencyKey` — validates them before transmit,
and sends them unchanged. A missing or mistyped field raises `PharosError` with
`code == "invalid_input"`; `submit()` never raises `PharosBlockedError`, it returns the verdict.

### Governing a tool (raises on block)

`govern_tool` wraps a callable so each call is submitted first and a `block` / `reject`
verdict raises `PharosBlockedError` (an `escalate` verdict waits for the human decision and
resumes exactly once). Its options are snake_case; `map_action` can override the default
`human_in_loop` / `irreversible` liability per call:

```python
from pharos_sdk import PharosBlockedError, govern_tool


def transfer(args: dict) -> dict:
    ...  # the real tool


governed_transfer = govern_tool(
    client,
    {"tenant_id": "acme", "agent_id": "billing-agent", "tool_name": "transfer"},
    transfer,
)

try:
    governed_transfer({"amount": 30000})
except PharosBlockedError as e:
    print("blocked:", e.reason, e.citations)
```

### Workflow continuation (escalation → human verdict → resume)

When an action escalates, park it and resume exactly once after a human decision:

```python
resolved = client.await_resolution(
    tenant_id="acme",
    escalation_id=result["escalation"]["id"],
)
```

## What you get

- **Deadline-aware** requests that respect the verdict budget.
- **Local fail-mode**: reversible actions fail open, irreversible actions fail closed, when
  Pharos is unreachable — the same semantics as the server.
- **Framework adapters** for CrewAI and the MS Agent Framework (`crewai_tool`,
  `ms_agent_tool`), plus a generic `govern_tool` / `Governor`.

## Verification

Every verdict is backed by a sealed, hash-chained evidence record that any third party can
verify offline from the exported bundle and the published public keyset — no Pharos
infrastructure required. See the
[main repository](https://github.com/Bobcatsfan33/Pharos) for the evidence model and the
offline verifier.

## License

Apache-2.0.
