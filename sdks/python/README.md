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
infrastructure required. `pharos_sdk.verify` is an independent, pure-Python implementation
of that procedure (`canonical_json`, `sha256_hex`, `verify_chain`, `verify_bundle`), written
from the documented rules rather than ported from the TypeScript reference. See the
[main repository](https://github.com/Bobcatsfan33/Pharos) for the evidence model.

## Command line

The distribution installs a `pharos` command. One subcommand is Python; the rest are the
Node CLI.

```bash
pipx install 'getpharos[verify]'
pharos verify evidence-bundle.json            # pure Python — no Node, no Pharos
# or, without installing anything:
pipx run --spec 'getpharos[verify]' pharos verify evidence-bundle.json
```

`pharos verify` checks every record's content hash, signature (Ed25519 or ECDSA P-256,
dispatching on the published keyset) and chain link from genesis to head, then the
bundle's `local` trusted-time anchors against its `tsaKeyset`. Signature checks need the
`cryptography` package, hence the `[verify]` extra; the SDK itself stays dependency-free.

Exit codes: `0` PASS · `1` FAIL · `2` PASS with skipped checks. The skip case is RFC 3161
anchors: their CMS tokens are **not** verified in Python. They are reported as `skipped`,
never as passed — verify them with
`npx @getpharos/cli verify --tsa-cert-sha256 <pinned fingerprint> evidence-bundle.json`.

`pharos init`, `demo`, `log`, `export`, `run` and `serve` seal records, and sealing is the
trust core — there is exactly one implementation of it, the TypeScript packages shipped as
[`@getpharos/cli`](https://www.npmjs.com/package/@getpharos/cli). The Python entry point
delegates those commands to `npx -y @getpharos/cli …`; without Node (>= 22.13) it says so
and exits 69. The control plane is Node; Python verifies it.

## Changelog

### 0.3.0

- New `pharos` console script: `pharos verify` (pure Python, `[verify]` extra for
  signatures); `init`/`demo`/`log`/`export`/`run`/`serve` delegate to `@getpharos/cli`.
- New `pharos_sdk.verify` module (canonical JSON, content hash, seal signature v1/v2,
  chain and bundle verification).

## License

Apache-2.0.
