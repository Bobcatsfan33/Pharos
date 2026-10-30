import json

from pharos_sdk.client import PharosClient


class Response:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return json.dumps({"success": True, "data": {"claimed": True}, "error": None}).encode()


def test_claim_sends_stable_claim_id(monkeypatch):
    seen = {}

    def urlopen(request, timeout):
        seen["body"] = json.loads(request.data.decode())
        return Response()

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    client = PharosClient("https://pharos.test", "key")

    assert client.claim("acme", "e1", "keel:claim:v1:abc")["claimed"] is True
    assert seen["body"] == {"claimId": "keel:claim:v1:abc"}


def test_request_exposes_the_envelope_contract(monkeypatch):
    """``request`` is the raw protocol call: envelope-checked, no local fail-mode."""
    import urllib.error

    import pytest

    from pharos_sdk.client import PharosError

    calls = {"n": 0}

    def urlopen(request, timeout):
        calls["n"] += 1
        assert request.get_header("X-api-key") == "key"
        raise urllib.error.HTTPError(request.full_url, 503, "down", {}, None)

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    client = PharosClient("https://pharos.test", "key", max_retries=1)
    with pytest.raises(PharosError) as raised:
        client.request("POST", "/v1/actions", {"tenantId": "acme"})
    assert raised.value.code == "unavailable"
    assert calls["n"] == 2

    class Malformed(Response):
        def read(self):
            return json.dumps({"success": False, "data": None}).encode()

    monkeypatch.setattr("urllib.request.urlopen", lambda request, timeout: Malformed())
    with pytest.raises(PharosError) as raised:
        PharosClient("https://pharos.test", "key", max_retries=0).request("GET", "/v1/x")
    assert raised.value.code == "invalid_response"
