"""Generate the golden event-log corpus (M2). Run once to (re)materialize the
committed historical logs under tests/golden/corpus/. Each file bundles a run's graph,
its event sequence, and the blobs the events reference, so the corpus replays
self-contained in CI:

    python -m tests.golden._gen_corpus
"""
import asyncio
import base64
import hashlib
import json
from pathlib import Path

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.model.port import ModelRequest, ModelResponse

CORPUS = Path(__file__).parent / "corpus"


class DeterministicPort:
    async def complete(self, req: ModelRequest) -> ModelResponse:
        h = hashlib.sha256(json.dumps(req.messages, sort_keys=True).encode()).hexdigest()
        return ModelResponse(text=json.dumps({"v": h[:16]}), tokens_in=7, tokens_out=4,
                             model=req.model)

    async def stream(self, req: ModelRequest):  # pragma: no cover
        yield ""

    def count_tokens(self, text: str, model: str) -> int:
        return max(1, len(text) // 4)


def _chain(gid: str, n: int) -> Graph:
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP,
                  config={"model": "mock:t", "prompt": f"step {i}"}) for i in range(n)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(n - 1)]
    return Graph(graph_id=gid, nodes=nodes, edges=edges)


def _branch(gid: str) -> Graph:
    return Graph(graph_id=gid,
                 nodes=[Node(id="r", type=NodeType.ROUTER, config={"branch": "x"}),
                        Node(id="x", type=NodeType.LLM_STEP, config={"model": "mock:t", "prompt": "x"}),
                        Node(id="y", type=NodeType.LLM_STEP, config={"model": "mock:t", "prompt": "y"})],
                 edges=[Edge.model_validate({"from": "r", "to": "x", "when": "branch:x"}),
                        Edge.model_validate({"from": "r", "to": "y", "when": "branch:y"})])


async def _dump(name: str, graph: Graph) -> None:
    runner = await Runner.open(in_memory=True, model=DeterministicPort())
    await runner.run(graph, run_id=name)
    events = await runner.read_events(name)
    blobs: dict[str, str] = {}
    for e in events:
        if e.payload_ref:
            digest = e.payload_ref.removeprefix("blob:sha256:")
            blobs[digest] = base64.b64encode(runner.blobs.get(e.payload_ref)).decode()
    bundle = {
        "graph": json.loads(graph.model_dump_json()),
        "events": [json.loads(e.to_json()) for e in events],
        "blobs": blobs,
    }
    CORPUS.mkdir(exist_ok=True)
    # NOT sort_keys: the free-form event `data` dict must keep its natural insertion
    # order so the stored JSON matches what the live code serializes (byte-identity).
    (CORPUS / f"{name}.json").write_text(json.dumps(bundle, indent=2))
    await runner.close()
    print(f"wrote {name}.json ({len(events)} events)")


async def main() -> None:
    await _dump("chain3", _chain("chain3", 3))
    await _dump("chain6", _chain("chain6", 6))
    await _dump("branch_x", _branch("branch_x"))


if __name__ == "__main__":
    asyncio.run(main())
