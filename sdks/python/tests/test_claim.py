import json

from pharos_sdk.client import PharosClient


class Response:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return json.dumps({"data": {"claimed": True}}).encode()


def test_claim_sends_stable_claim_id(monkeypatch):
    seen = {}

    def urlopen(request, timeout):
        seen["body"] = json.loads(request.data.decode())
        return Response()

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    client = PharosClient("https://pharos.test", "key")

    assert client.claim("acme", "e1", "keel:claim:v1:abc")["claimed"] is True
    assert seen["body"] == {"claimId": "keel:claim:v1:abc"}
