from __future__ import annotations

import json
from typing import Any, Mapping

import httpx
import pytest

from keel.kir.schema import Graph, Node, NodeType
from keel.services.model.handlers import MockModelPort
from keel.services.pharos import PharosConfig, PharosError, PharosGovernance, PharosHttpClient
from keel.services.runner import Runner
from keel.substrate.events import EventType


def _config() -> PharosConfig:
    return PharosConfig(
        base_url="https://pharos.test",
        api_key="secret-key",
        tenant_id="acme",
        max_retries=0,
    )


def _graph(config: dict[str, Any] | None = None) -> Graph:
    return Graph(
        graph_id="governed",
        nodes=[Node(id="act", type=NodeType.LLM_STEP, config=config or {"prompt": "secret"})],
        edges=[],
    )


def _submission(decision: str, status: str | None = None) -> dict[str, Any]:
    return {
        "verdict": {
            "decision": decision,
            "riskScore": 0.8,
            "tierReached": 1,
            "ruleCitations": [{"ruleId": "test-rule", "pack": "test"}],
        },
        "record": {
            "content": {"id": "record-1", "sequence": 7},
            "seal": {"contentHash": "abc123", "keyId": "key-1"},
        },
        "escalation": {"id": "esc-1", "status": status} if status else None,
        "replayed": False,
    }


class FakePharos:
    def __init__(self, decision: str, status: str | None = None) -> None:
        self.decision = decision
        self.status = status
        self.requests: list[Mapping[str, Any]] = []
        self.claim_ids: list[str] = []
        self.modified_config: dict[str, Any] | None = None

    async def submit(self, body: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append(body)
        return _submission(self.decision, self.status)

    async def claim(
        self, tenant_id: str, escalation_id: str, claim_id: str
    ) -> dict[str, Any]:
        self.claim_ids.append(claim_id)
        return {
            "claimed": True,
            "status": self.status,
            "resolution": {
                "modifiedAction": {
                    "payload": {"keelConfig": self.modified_config}
                }
            }
            if self.modified_config is not None
            else None,
        }

    async def close(self) -> None:
        return None


async def _runner(fake: FakePharos, model: MockModelPort | None = None) -> Runner:
    runner = await Runner.open(in_memory=True, model=model or MockModelPort())
    runner.governance = PharosGovernance(_config(), fake)
    return runner


@pytest.mark.asyncio
async def test_allow_seals_evidence_before_execution_without_leaking_node_config() -> None:
    fake = FakePharos("allow")
    runner = await _runner(fake)
    state = await runner.run(
        _graph(
            {
                "prompt": "customer secret must not cross the boundary",
                "pharos": {"payload": {"operation": "summarize"}},
            }
        ),
        run_id="run-allow",
    )
    events = await runner.read_events("run-allow")
    await runner.close()

    assert state.status == "completed"
    assert [e.type for e in events].index(EventType.GOVERNANCE_DECIDED) < [
        e.type for e in events
    ].index(EventType.STEP_STARTED)
    decision = next(e for e in events if e.type == EventType.GOVERNANCE_DECIDED)
    assert decision.data["record_id"] == "record-1"
    assert decision.data["content_hash"] == "abc123"
    wire = json.dumps(fake.requests[0])
    assert "customer secret" not in wire
    assert fake.requests[0]["action"]["payload"]["operation"] == "summarize"


@pytest.mark.asyncio
async def test_block_prevents_the_step_from_starting() -> None:
    model = MockModelPort()
    fake = FakePharos("block")
    runner = await _runner(fake, model)
    state = await runner.run(_graph(), run_id="run-block")
    events = await runner.read_events("run-block")
    await runner.close()

    assert state.status == "failed"
    assert model.calls == 0
    assert EventType.STEP_STARTED not in [event.type for event in events]


@pytest.mark.asyncio
async def test_escalation_parks_then_resumes_with_same_authorization_and_claim() -> None:
    model = MockModelPort()
    fake = FakePharos("escalate", "pending")
    runner = await _runner(fake, model)
    first = await runner.run(_graph(), run_id="run-escalate")
    assert first.status == "paused"
    assert model.calls == 0

    fake.status = "approved"
    second = await runner.resume("run-escalate")
    await runner.close()

    assert second.status == "completed"
    assert model.calls == 1
    assert fake.requests[0]["idempotencyKey"] == fake.requests[1]["idempotencyKey"]
    assert len(fake.claim_ids) == 1


@pytest.mark.asyncio
async def test_lost_claim_response_is_recovered_with_the_same_claim_identity() -> None:
    class LostResponsePharos(FakePharos):
        lost = False

        async def claim(
            self, tenant_id: str, escalation_id: str, claim_id: str
        ) -> dict[str, Any]:
            self.claim_ids.append(claim_id)
            if not self.lost:
                self.lost = True
                # The server committed ownership, but the process lost the response.
                raise PharosError("connection lost", code="unavailable", retryable=True)
            return {"claimed": True, "status": "approved", "resolution": None}

    model = MockModelPort()
    fake = LostResponsePharos("escalate", "approved")
    runner = await _runner(fake, model)
    first = await runner.run(_graph(), run_id="run-lost-claim")
    assert first.status == "paused"
    assert model.calls == 0

    recovered = await runner.resume("run-lost-claim")
    await runner.close()

    assert recovered.status == "completed"
    assert model.calls == 1
    assert fake.claim_ids[0] == fake.claim_ids[1]


@pytest.mark.asyncio
async def test_human_modified_action_replaces_executable_node_config() -> None:
    fake = FakePharos("escalate", "modified")
    fake.modified_config = {"prompt": "reviewer-approved"}
    runner = await _runner(fake)
    observed: list[str] = []

    async def handler(_ctx: Any, node: Node, _inputs: dict[str, bytes]) -> bytes:
        observed.append(str(node.config["prompt"]))
        return b"ok"

    runner.handlers[NodeType.LLM_STEP] = handler
    state = await runner.run(_graph(), run_id="run-modified")
    await runner.close()

    assert state.status == "completed"
    assert observed == ["reviewer-approved"]


@pytest.mark.asyncio
async def test_unavailable_pharos_fails_closed_by_parking_the_run() -> None:
    async def unavailable(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    config = _config()
    client = PharosHttpClient(config, transport=httpx.MockTransport(unavailable))
    runner = await Runner.open(in_memory=True, model=MockModelPort())
    runner.governance = PharosGovernance(config, client)
    state = await runner.run(_graph(), run_id="run-offline")
    events = await runner.read_events("run-offline")
    await client.close()
    await runner.close()

    assert state.status == "paused"
    assert EventType.GOVERNANCE_UNAVAILABLE in [event.type for event in events]


@pytest.mark.asyncio
async def test_http_client_sends_pharos_contract_and_replay_safe_claim_id() -> None:
    seen: list[httpx.Request] = []

    async def endpoint(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/claim"):
            return httpx.Response(
                200,
                json={"success": True, "data": {"claimed": True}, "error": None},
            )
        return httpx.Response(
            201,
            json={"success": True, "data": _submission("allow"), "error": None},
        )

    client = PharosHttpClient(_config(), transport=httpx.MockTransport(endpoint))
    submitted = await client.submit({"tenantId": "acme"})
    claimed = await client.claim("acme", "esc-1", "keel:claim:v1:123")
    await client.close()

    assert submitted["verdict"]["decision"] == "allow"
    assert claimed["claimed"] is True
    assert seen[0].headers["x-api-key"] == "secret-key"
    assert json.loads(seen[1].content) == {"claimId": "keel:claim:v1:123"}
