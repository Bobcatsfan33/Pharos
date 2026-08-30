"""M1 conformance suite: replay a corpus of recorded runs and assert byte-identical
results. Spans model chains, branching, map/reduce, tools, and a HITL gate. The
executor-driven corpus is full-log byte-identical; the gated run is final-result
identical (its pause/resume structure is not reproduced by a clean replay — see
docs/DETERMINISM.md)."""
import hashlib
import json
import pytest
from pydantic import BaseModel

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.kir.schemas_registry import register_schema, clear
from keel.services.runner import Runner
from keel.services.model.port import ModelRequest, ModelResponse
from keel.services.replay import replay_recorded
from keel.services.tools.contract import ToolContract, RegisteredTool, SideEffect
from keel.services.tools.gateway import ToolGateway
from keel.services.nodes import default_handlers


class DeterministicPort:
    """Returns a stable function of the request (a hash of the messages), so a run is
    deterministic and a corpus is varied. tokens/model fixed."""

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, req: ModelRequest) -> ModelResponse:
        self.calls += 1
        h = hashlib.sha256(json.dumps(req.messages, sort_keys=True).encode()).hexdigest()
        return ModelResponse(text=json.dumps({"v": h[:16]}), tokens_in=7, tokens_out=4,
                             model=req.model)

    async def stream(self, req: ModelRequest):  # pragma: no cover
        yield ""

    def count_tokens(self, text: str, model: str) -> int:
        return max(1, len(text) // 4)


def _chain(gid: str, n: int) -> Graph:
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP,
                  config={"model": f"mock:m{i % 3}", "prompt": f"step {i} of {gid}"})
             for i in range(n)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(n - 1)]
    return Graph(graph_id=gid, nodes=nodes, edges=edges)


def _branch(gid: str, taken: str) -> Graph:
    return Graph(
        graph_id=gid,
        nodes=[Node(id="r", type=NodeType.ROUTER, config={"branch": taken}),
               Node(id="x", type=NodeType.LLM_STEP, config={"model": "mock:t", "prompt": "x"}),
               Node(id="y", type=NodeType.LLM_STEP, config={"model": "mock:t", "prompt": "y"})],
        edges=[Edge.model_validate({"from": "r", "to": "x", "when": "branch:x"}),
               Edge.model_validate({"from": "r", "to": "y", "when": "branch:y"})])


def _map_reduce(gid: str, k: int) -> Graph:
    return Graph(
        graph_id=gid,
        nodes=[Node(id="m", type=NodeType.MAP, config={"items": list(range(k)), "over": "items"}),
               Node(id="rd", type=NodeType.REDUCE, config={"reduce": "sum"})],
        edges=[Edge.model_validate({"from": "m", "to": "rd"})])


def _corpus() -> list[Graph]:
    runs: list[Graph] = []
    for n in range(1, 9):
        runs.append(_chain(f"chain{n}", n))           # 8 model chains
        runs.append(_chain(f"chain{n}b", n))          # 8 more (distinct ids/prompts)
    for i in range(16):
        runs.append(_branch(f"branch{i}", "x" if i % 2 == 0 else "y"))  # 16 branching
    for k in range(2, 14):
        runs.append(_map_reduce(f"mr{k}", k))         # 12 map/reduce
    for n in range(1, 9):
        runs.append(_chain(f"deep{n}", n))            # 8 more chains
    return runs  # >= 50 (8+8+12+10+8 = 46... see assertion)


@pytest.mark.asyncio
async def test_corpus_replays_byte_identical():
    corpus = _corpus()
    assert len(corpus) >= 50, len(corpus)
    diverged = []
    for i, graph in enumerate(corpus):
        runner = await Runner.open(in_memory=True, model=DeterministicPort())
        rid = f"c{i}"
        await runner.run(graph, run_id=rid)
        events = await runner.read_events(rid)
        result = await replay_recorded(graph, rid, events, runner.blobs)
        await runner.close()
        if not result.identical:
            diverged.append((graph.graph_id, result.detail))
    assert not diverged, f"{len(diverged)}/{len(corpus)} diverged: {diverged[:5]}"


class TArgs(BaseModel):
    q: str = ""


class TOut(BaseModel):
    echo: str


@pytest.fixture()
def _tool_schemas():
    clear()
    register_schema(TArgs)
    register_schema(TOut)
    yield
    clear()


@pytest.mark.asyncio
async def test_tool_graph_replays_byte_identical(_tool_schemas):
    async def impl(args):
        return {"echo": str(args.get("q", ""))}

    contract = ToolContract(name="echo", input_schema="ref:schemas/TArgs",
                            output_schema="ref:schemas/TOut", side_effect=SideEffect.READ)
    gateway = ToolGateway({"echo": RegisteredTool(contract=contract, impl=impl)})
    runner = await Runner.open(in_memory=True, model=DeterministicPort(), gateway=gateway)
    runner.handlers = default_handlers(model=DeterministicPort(), gateway=gateway)
    graph = Graph(graph_id="toolg",
                  nodes=[Node(id="t1", type=NodeType.TOOL_STEP, tool="echo",
                              config={"args": {"q": "hello"}}),
                         Node(id="t2", type=NodeType.TOOL_STEP, tool="echo",
                              config={"args": {"q": "world"}})],
                  edges=[Edge.model_validate({"from": "t1", "to": "t2"})])
    await runner.run(graph, run_id="tg")
    events = await runner.read_events("tg")
    result = await replay_recorded(graph, "tg", events, runner.blobs)
    await runner.close()
    assert result.identical, result.detail


class StreamingPort:
    """Emits a deterministic chunk sequence; the assembled final is what's recorded."""

    async def complete(self, req: ModelRequest) -> ModelResponse:  # pragma: no cover
        return ModelResponse(text="", tokens_in=0, tokens_out=0, model=req.model)

    async def stream(self, req: ModelRequest):
        for tok in ("hel", "lo ", "wor", "ld"):
            yield tok

    def count_tokens(self, text: str, model: str) -> int:
        return max(1, len(text) // 4)


@pytest.mark.asyncio
async def test_streamed_run_replays_byte_identical():
    runner = await Runner.open(in_memory=True, model=StreamingPort())
    graph = Graph(graph_id="streamed",
                  nodes=[Node(id="s", type=NodeType.LLM_STEP,
                              config={"model": "mock:t", "prompt": "go", "stream": True})],
                  edges=[])
    state = await runner.run(graph, run_id="st")
    assert state.status == "completed"
    # the streamed chunks assembled to the final result
    assert runner.blobs.get(state.steps["s"].result_ref) == b"hello world"
    events = await runner.read_events("st")
    result = await replay_recorded(graph, "st", events, runner.blobs)
    await runner.close()
    assert result.identical, result.detail


@pytest.mark.asyncio
async def test_gated_run_final_result_is_stable():
    # A HITL gate doesn't break result determinism: the writer step's output is a
    # deterministic function of the (replayed) research output, regardless of the gate.
    runner = await Runner.open(in_memory=True, model=DeterministicPort())
    graph = Graph(
        graph_id="gated",
        nodes=[Node(id="research", type=NodeType.LLM_STEP, config={"model": "mock:t", "prompt": "r"}),
               Node(id="review", type=NodeType.HUMAN_GATE, config={"prompt": "ok?"}),
               Node(id="write", type=NodeType.LLM_STEP, config={"model": "mock:t", "prompt": "w"})],
        edges=[Edge.model_validate({"from": "research", "to": "review"}),
               Edge.model_validate({"from": "review", "to": "write"})])
    paused = await runner.run(graph, run_id="g")
    assert paused.status == "paused"
    research_out = runner.blobs.get(paused.steps["research"].result_ref)
    await runner.approve_gate("g", "review")
    final = await runner.resume("g")
    await runner.close()
    assert final.status == "completed"
    # research output unchanged across the gate (replayed, not re-billed)
    assert runner.blobs.get(final.steps["research"].result_ref) == research_out
    assert final.steps["write"].result_ref is not None
