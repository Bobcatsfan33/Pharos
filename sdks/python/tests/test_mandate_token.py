"""MandateToken conformance (Python).

The vectors in packages/core/test/mandate-token/vectors.json are the contract shared with
``@pharos/core`` and ``@getpharos/sdk``. Both signature paths are exercised: ``cryptography``
when installed, and the stdlib-only pure-Python Ed25519 / ECDSA P-256 fallback.
"""
import builtins
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from pharos_sdk import PharosClient, PharosError, effective_authority, verify_mandate_token
from pharos_sdk import mandate_token as mt

VECTORS = Path(__file__).resolve().parents[3] / "packages" / "core" / "test" / "mandate-token" / "vectors.json"
FIXTURE = json.loads(VECTORS.read_text())
KEYSET = {k["keyId"]: k for k in FIXTURE["keyset"]}
BY_NAME = {v["name"]: v for v in FIXTURE["vectors"]}


def _at(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _run_vectors():
    for v in FIXTURE["vectors"]:
        r = verify_mandate_token(v["token"], KEYSET[v["rootKeyId"]], _at(v["now"]), v["expect"])
        assert r.ok == v["result"]["ok"], (v["name"], r.errors)
        assert r.code == v["result"]["code"], (v["name"], r.errors)
        if v["result"]["ok"]:
            assert r.effective == v["result"]["effective"], v["name"]
            assert r.effective == effective_authority(v["token"])
            assert len(r.block_hashes) == len(v["token"]["blocks"]) + 1
        else:
            assert r.effective is None


def test_vectors_with_cryptography_when_available():
    pytest.importorskip("cryptography")
    _run_vectors()


def test_vectors_pure_python(monkeypatch):
    """Force the stdlib path even when cryptography is installed."""
    real_import = builtins.__import__

    def no_cryptography(name, *args, **kwargs):
        if name.startswith("cryptography"):
            raise ImportError("blocked for the pure-python path")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_cryptography)
    for key in [k for k in sys.modules if k.startswith("cryptography")]:
        monkeypatch.delitem(sys.modules, key, raising=False)
    _run_vectors()


def test_canonical_json_matches_the_typescript_canonicalizer():
    assert mt.canonical_json({"b": 1, "a": [1.5, 2, "x\n"], "c": None}) == '{"a":[1.5,2,"x\\n"],"b":1,"c":null}'
    assert mt.canonical_json(25000.0) == "25000"
    assert mt.canonical_json(True) == "true"
    # The block hashes sealed by the server are the sha256 of each canonical block.
    valid = BY_NAME["valid-chain"]["token"]
    r = verify_mandate_token(valid, KEYSET[valid["authority"]["keyId"]], _at(BY_NAME["valid-chain"]["now"]))
    assert r.block_hashes == mt.token_block_hashes(valid)
    assert all(len(h) == 64 for h in r.block_hashes)


def _liability(reversibility="reversible", amount=0):
    return {
        "mandate": None,
        "oversightMode": "autonomous",
        "blastRadius": {"financialAmount": amount, "currency": "USD", "reversibility": reversibility},
        "modelMetadata": None,
    }


def test_client_blocks_an_invalid_token_locally_and_still_submits_for_sealing():
    client = PharosClient(base_url="http://127.0.0.1:1", api_key="k", max_retries=0,
                          mandate_token_root_keys=list(KEYSET.values()))
    events = []
    client.on_event = events.append
    res = client.submit(tenantId="acme", action={"type": "payment.transfer", "agentId": "treasury-agent", "payload": {}},
                        liability=_liability(), mandateToken=BY_NAME["truncated-chain"]["token"])
    assert res["localVerdict"] == "mandate-token-invalid"
    assert res["verdict"]["decision"] == "block"
    assert res["verdict"]["ruleCitations"][0]["ruleId"] == "mandate-token-invalid"
    assert "proof" in res["verdict"]["ruleCitations"][0]["description"]
    res["sealed"].join(timeout=10)
    # The platform is unreachable here, so sealing fell back locally — and that is reported, not hidden.
    assert res["sealed"].result is not None and res["sealed"].result["localFallback"] is True
    assert any(e["type"] == "local-verdict" for e in events)


def test_client_leaves_a_valid_token_to_the_server_unless_local_allow_is_on():
    token = BY_NAME["valid-chain"]["token"]
    off = PharosClient(base_url="http://127.0.0.1:1", api_key="k", max_retries=0,
                       mandate_token_root_keys=list(KEYSET.values()))
    res = off.submit(tenantId="acme", action={"type": "payment.transfer", "agentId": "treasury-agent", "payload": {}},
                     liability=_liability(), mandateToken=token)
    assert "localVerdict" not in res and res["localFallback"] is True  # went to the (unreachable) server

    on = PharosClient(base_url="http://127.0.0.1:1", api_key="k", max_retries=0,
                      mandate_token_root_keys=list(KEYSET.values()), mandate_token_local_allow=True)
    res = on.submit(tenantId="acme", action={"type": "payment.transfer", "agentId": "treasury-agent", "payload": {}},
                    liability=_liability(), mandateToken=token)
    assert res["localVerdict"] == "mandate-token-allow"
    assert res["verdict"]["decision"] == "allow"
    res["sealed"].join(timeout=10)
    assert res["sealed"].result["localFallback"] is True
    # Out of scope, money, or irreversible: never a local allow.
    for action_type, liability in [
        ("payment.refund", _liability()),
        ("payment.transfer", _liability(amount=5)),
        ("payment.transfer", _liability(reversibility="irreversible")),
    ]:
        res = on.submit(tenantId="acme", action={"type": action_type, "agentId": "treasury-agent", "payload": {}},
                        liability=liability, mandateToken=token)
        assert "localVerdict" not in res, action_type

def test_validation_refuses_a_token_combined_with_a_mandate_id():
    client = PharosClient(base_url="http://127.0.0.1:1", api_key="k", max_retries=0)
    with pytest.raises(PharosError) as err:
        client.submit(tenantId="acme", action={"type": "x", "agentId": "a", "payload": {}},
                      liability=_liability(), mandateId="m", mandateToken={"v": 1})
    assert err.value.code == "invalid_input"
