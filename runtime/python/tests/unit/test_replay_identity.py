"""P2-6: recorded replay is byte-identical; a patched replay diverges only
downstream of the patch."""
import json
import pytest

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.model.handlers import ScriptedModelPort, MockModelPort
from keel.services.model.port import ModelRequest
from keel.services.replay import (replay_recorded, replay_patched, RecordedModelPort,
                                  ReplayDivergence)


def _chain() -> Graph:
    return Graph(
        graph_id="chain",
        nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
               Node(id="b", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
               Node(id="c", type=NodeType.LLM_STEP, config={"model": "mock:test"})],
        edges=[Edge.model_validate({"from": "a", "to": "b"}),
               Edge.model_validate({"from": "b", "to": "c"})],
    )


@pytest.mark.asyncio
async def test_recorded_replay_is_byte_identical():
    # distinct replies per call so replay must feed them back in the right order
    model = ScriptedModelPort(['{"step": "a"}', '{"step": "b"}', '{"step": "c"}'])
    runner = await Runner.open(in_memory=True, model=model)
    graph = _chain()
    await runner.run(graph, run_id="orig")
    events = await runner.read_events("orig")

    result = await replay_recorded(graph, "orig", events, runner.blobs)
    await runner.close()
    assert result.identical, result.detail
    assert len(result.replayed) == len(events)


@pytest.mark.asyncio
async def test_recorded_model_port_flags_extra_calls():
    port = RecordedModelPort([])  # nothing recorded
    with pytest.raises(ReplayDivergence):
        await port.complete(ModelRequest(model="m", messages=[], max_tokens=1))


@pytest.mark.asyncio
async def test_patched_replay_diverges_only_downstream():
    model = ScriptedModelPort(['{"step": "a"}', '{"step": "b"}', '{"step": "c"}'])
    runner = await Runner.open(in_memory=True, model=model)
    graph = _chain()
    await runner.run(graph, run_id="orig3")
    events = await runner.read_events("orig3")
    original_a_ref = (await runner.load_state("orig3")).steps["a"].result_ref

    patched = await replay_patched(graph, "orig3", events, runner.blobs,
                                   from_step="b", patch={"step": "PATCHED"},
                                   model=MockModelPort(reply='{"live": true}'))

    # upstream 'a' unchanged (same recorded blob ref)
    assert patched.steps["a"].result_ref == original_a_ref
    # 'b' carries the patched value
    assert json.loads(runner.blobs.get(patched.steps["b"].result_ref)) == {"step": "PATCHED"}
    # downstream 'c' re-executed LIVE
    assert patched.steps["c"].status == "completed"
    assert json.loads(runner.blobs.get(patched.steps["c"].result_ref)) == {"live": True}
    await runner.close()
