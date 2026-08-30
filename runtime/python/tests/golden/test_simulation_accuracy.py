"""P3-5: keel simulate's estimate tracks an actual run within +/-15%. The model bills
tokens proportional to its prompt (input) with a per-node output that jitters around
the simulator's assumption."""
import pytest

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.simulate import simulate_run
from keel.services.model.pricing import PriceTable
from keel.services.model.port import ModelRequest, ModelResponse


class CalibratedPort:
    """Bills input tokens ~ prompt size (≈ what the compiler estimates from the same
    prompt) and output tokens near `out` with a small deterministic jitter."""

    def __init__(self, out: int = 256) -> None:
        self._out = out
        self.calls = 0

    async def complete(self, req: ModelRequest) -> ModelResponse:
        self.calls += 1
        in_tok = sum(len(m["content"]) // 4 for m in req.messages)
        jitter = 1.0 + (0.1 if self.calls % 2 else -0.1)  # +/-10%
        out_tok = int(self._out * jitter)
        return ModelResponse(text='{"ok": true}', tokens_in=in_tok, tokens_out=out_tok,
                             model=req.model)

    async def stream(self, req: ModelRequest):  # pragma: no cover
        yield "{}"

    def count_tokens(self, text: str, model: str) -> int:
        return len(text) // 4


def _graph() -> Graph:
    nodes = [
        Node(id="a", type=NodeType.LLM_STEP, config={
            "model": "anthropic:claude-haiku-4-5", "prompt": "Research " + "x " * 50,
            "expected_output_tokens": 256}),
        Node(id="b", type=NodeType.LLM_STEP, config={
            "model": "anthropic:claude-sonnet-4-6", "prompt": "Write " + "y " * 80,
            "expected_output_tokens": 256}),
    ]
    return Graph(graph_id="sim", nodes=nodes, edges=[Edge.model_validate({"from": "a", "to": "b"})])


@pytest.mark.asyncio
async def test_sim_within_15pct_of_actual():
    graph = _graph()
    table = PriceTable()
    sim = simulate_run(graph, price_table=table, default_output_tokens=256)

    runner = await Runner.open(in_memory=True, model=CalibratedPort(out=256),
                               price_table=PriceTable())
    final = await runner.run(graph, run_id="sim1")
    await runner.close()
    assert final.status == "completed"

    actual = final.total_cost_usd
    assert actual > 0 and sim.total_usd > 0
    rel = abs(sim.total_usd - actual) / actual
    assert rel <= 0.15, f"sim ${sim.total_usd:.6f} vs actual ${actual:.6f} = {rel*100:.1f}% off"
