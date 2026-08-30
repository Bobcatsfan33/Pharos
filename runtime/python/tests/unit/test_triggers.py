"""P4-4: HMAC-verified webhook trigger starts a run; bad/missing signature is
rejected; unknown graph is 404."""

import hashlib
import hmac

import pytest

from keel.kir.schema import Graph, Node, NodeType
from keel.services.model.handlers import MockModelPort
from keel.services.runner import Runner
from keel.services.triggers import TriggerService, verify_hmac

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from keel.services.triggers import create_trigger_app

SECRET = "topsecret"


def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()


def test_verify_hmac():
    body = b'{"x":1}'
    assert verify_hmac(SECRET, body, _sign(body))
    assert not verify_hmac(SECRET, body, "sha256=deadbeef")
    assert not verify_hmac(SECRET, body, None)


@pytest.mark.asyncio
async def test_webhook_trigger_starts_run():
    runner = await Runner.open(in_memory=True, model=MockModelPort())
    graph = Graph(
        graph_id="ingest",
        nodes=[Node(id="n", type=NodeType.LLM_STEP, config={"model": "mock:test"})],
        edges=[],
    )
    service = TriggerService(runner, {"ingest": graph}, SECRET)

    with TestClient(create_trigger_app(service)) as client:
        body = b'{"event": "doc.created"}'
        # valid signature -> run starts and completes
        r = client.post(
            "/v1/triggers/ingest", content=body, headers={"X-Keel-Signature": _sign(body)}
        )
        assert r.status_code == 200 and r.json()["status"] == "completed"
        assert r.json()["replayed"] is False
        # bad signature -> 401
        assert (
            client.post(
                "/v1/triggers/ingest", content=body, headers={"X-Keel-Signature": "sha256=nope"}
            ).status_code
            == 401
        )
        # missing signature -> 401
        assert client.post("/v1/triggers/ingest", content=body).status_code == 401
        # unknown graph (valid sig) -> 404
        assert (
            client.post(
                "/v1/triggers/unknown", content=body, headers={"X-Keel-Signature": _sign(body)}
            ).status_code
            == 404
        )
    await runner.close()


@pytest.mark.asyncio
async def test_webhook_idempotency_key_admits_exactly_one_run_and_binds_body():
    runner = await Runner.open(in_memory=True, model=MockModelPort())
    graph = Graph(
        graph_id="ingest",
        nodes=[Node(id="n", type=NodeType.LLM_STEP, config={"model": "mock:test"})],
        edges=[],
    )
    service = TriggerService(runner, {"ingest": graph}, SECRET)

    with TestClient(create_trigger_app(service)) as client:
        body = b'{"event": "doc.created"}'
        headers = {"X-Keel-Signature": _sign(body), "Idempotency-Key": "delivery-42"}
        first = client.post("/v1/triggers/ingest", content=body, headers=headers)
        replay = client.post("/v1/triggers/ingest", content=body, headers=headers)
        assert first.status_code == replay.status_code == 200
        assert first.json()["run_id"] == replay.json()["run_id"]
        assert first.json()["replayed"] is False
        assert replay.json()["replayed"] is True
        runs = await runner.list_runs()
        assert len(runs) == 1

        changed = b'{"event": "different"}'
        conflict = client.post(
            "/v1/triggers/ingest",
            content=changed,
            headers={"X-Keel-Signature": _sign(changed), "Idempotency-Key": "delivery-42"},
        )
        assert conflict.status_code == 409
        assert len(await runner.list_runs()) == 1

        invalid = client.post(
            "/v1/triggers/ingest",
            content=body,
            headers={"X-Keel-Signature": _sign(body), "Idempotency-Key": "bad key"},
        )
        assert invalid.status_code == 400
    await runner.close()
