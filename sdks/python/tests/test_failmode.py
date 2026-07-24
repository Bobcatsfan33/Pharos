"""SDK local fail-mode conformance (Python).

When the platform is unreachable — which includes a 503 kms_unavailable from S3-T2 — the SDK
applies a local fail-mode mirroring the server cascade: reversible -> fail_open (allow),
irreversible -> fail_closed (escalate). The TypeScript SDK conformance for the same contract
lives in test/sdk.failmode.test.ts.
"""
from pharos_sdk import PharosClient


def _client(local_fail_mode):
    # An unreachable base URL forces the local fallback path.
    return PharosClient(base_url="http://127.0.0.1:1", api_key="k", max_retries=0,
                        local_fail_mode=local_fail_mode)


def _liability(reversibility):
    return {
        "mandate": None,
        "oversightMode": "autonomous",
        "blastRadius": {"financialAmount": 0, "currency": "USD", "reversibility": reversibility},
        "modelMetadata": None,
    }


_ACTION = {"type": "email.send", "agentId": "a1", "payload": {}}


def test_reversible_fails_open_even_when_default_closed():
    res = _client("fail_closed").submit(
        tenantId="t", action=_ACTION, liability=_liability("reversible"))
    assert res["localFallback"] is True
    assert res["verdict"]["decision"] == "allow"
    assert res["verdict"]["failMode"] == "fail_open"


def test_irreversible_fails_closed_even_when_default_open():
    res = _client("fail_open").submit(
        tenantId="t", action=_ACTION, liability=_liability("irreversible"))
    assert res["localFallback"] is True
    assert res["verdict"]["decision"] == "escalate"
    assert res["verdict"]["failMode"] == "fail_closed"
