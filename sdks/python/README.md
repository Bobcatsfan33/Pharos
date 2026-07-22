# pharos-sdk

The Python SDK for [Pharos](https://github.com/Bobcatsfan33/Pharos) — the trust control
plane for enterprise AI agents.

Submit an agent action to Pharos **before it executes** and receive a policy verdict
(`allow` / `block` / `modify` / `escalate`) plus a cryptographically sealed evidence record —
two outputs of one transaction. The client honors the verdict deadline, retries transient
failures, and falls back to a safe local default if the platform is unreachable.

The SDK is **dependency-free** (Python standard library only) so it installs anywhere.

## Install

```bash
pip install pharos-sdk
```

Requires Python 3.9+.

## Quickstart

```python
from pharos_sdk import PharosClient, PharosBlockedError

client = PharosClient(
    base_url="https://pharos.example.com",
    api_key="pk_...",
    deadline_ms=800,
    local_fail_mode="fail_closed",  # or "fail_open" for reversible actions
)

try:
    result = client.submit(
        tenant_id="acme",
        agent_id="billing-agent",
        action={"type": "payment.transfer", "payload": {"amount": 30000}},
    )
    verdict = result["verdict"]
    if verdict["decision"] == "allow":
        ...  # proceed with the action
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
