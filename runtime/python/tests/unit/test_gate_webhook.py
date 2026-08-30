"""P2-4/P2-5: gate webhook notify + GateService (approve re-enqueues; decision is
durable and worker-agnostic)."""
import json
import httpx
import pytest

from keel.authoring import Agent, Task, Crew
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.notify import WebhookNotifier
from keel.services.gate_service import GateService
from keel.services.scheduler import MemoryScheduler


def _gated_crew():
    a = Agent("researcher", goal="research")
    b = Agent("editor", goal="approve")
    t1 = Task("Research", agent=a)
    gate = Task("Approve", agent=b, human_gate=True, context=[t1])
    return Crew("g", tasks=[t1, gate]).compile()


def _capturing_client():
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"ok": True})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), captured


@pytest.mark.asyncio
async def test_webhook_fires_on_gate_open_with_signature():
    client, captured = _capturing_client()
    notifier = WebhookNotifier("https://hook.example/keel", secret="s3cr3t", client=client)
    runner = await Runner.open(in_memory=True, model=MockModelPort(), listeners=[notifier])
    state = await runner.run(_gated_crew(), run_id="gw1")
    await runner.close()

    assert state.status == "paused"
    assert len(captured) == 1
    req = captured[0]
    body = json.loads(req.content)
    assert body["type"] == "gate.opened" and body["run_id"] == "gw1"
    assert req.headers["X-Keel-Signature"].startswith("sha256=")
    assert notifier.sent and notifier.sent[0]["type"] == "gate.opened"


@pytest.mark.asyncio
async def test_gate_service_approve_enqueues_and_resumes():
    model = MockModelPort()
    runner = await Runner.open(in_memory=True, model=model)
    scheduler = MemoryScheduler()
    await runner.run(_gated_crew(), run_id="gs1")

    gates = GateService(runner.store, runner.ids, runner.clock, runner.blobs, scheduler)
    await gates.approve("gs1", "approve")
    assert scheduler.qsize() == 1                      # run re-enqueued for any worker
    assert await scheduler.dequeue() == "gs1"

    final = await runner.resume("gs1")                 # a worker would do exactly this
    await runner.close()
    assert final.status == "completed"


@pytest.mark.asyncio
async def test_gate_reject_fails_run():
    runner = await Runner.open(in_memory=True, model=MockModelPort())
    await runner.run(_gated_crew(), run_id="gs2")
    await runner.reject_gate("gs2", "approve")
    final = await runner.resume("gs2")
    await runner.close()
    assert final.status == "failed"
