"""P3-7: cross-run cost rollup aggregates spend by graph/model/node/tenant/day and
surfaces the most-expensive steps."""
import pytest

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.model.pricing import PriceTable
from keel.services.cost import cost_rollup


def _chain(gid: str) -> Graph:
    return Graph(
        graph_id=gid,
        nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "anthropic:claude-haiku-4-5"}),
               Node(id="b", type=NodeType.LLM_STEP, config={"model": "openai:gpt-4o"})],
        edges=[Edge.model_validate({"from": "a", "to": "b"})],
    )


@pytest.mark.asyncio
async def test_cost_rollup_dimensions_and_board():
    runner = await Runner.open(in_memory=True, model=MockModelPort(),
                               price_table=PriceTable(), tenant="acme")
    await runner.run(_chain("pipeline_x"), run_id="r1")
    await runner.run(_chain("pipeline_y"), run_id="r2")

    roll = await cost_rollup(runner.store, runner.catalog)
    await runner.close()

    assert roll.total_usd > 0
    assert set(roll.by_graph) == {"pipeline_x", "pipeline_y"}
    assert set(roll.by_model) == {"anthropic:claude-haiku-4-5", "openai:gpt-4o"}
    assert "acme" in roll.by_tenant
    assert "pipeline_x.a" in roll.by_node and "pipeline_x.b" in roll.by_node
    # by-graph spend reconciles with the total
    assert abs(sum(roll.by_graph.values()) - roll.total_usd) < 1e-9
    # most-expensive board is sorted desc and non-empty
    usds = [s["usd"] for s in roll.most_expensive]
    assert usds and usds == sorted(usds, reverse=True)
    # gpt-4o is pricier than haiku for equal tokens -> tops the board
    assert roll.most_expensive[0]["node_id"] == "b"
