"""Phase 3 exit gate: a $2 budget on a ~$5 pipeline pauses with full state at a step
boundary; raising the budget and resuming completes it from where it stopped."""
import pytest

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.budget import Budget, BudgetAction
from keel.services.model.handlers import MockModelPort
from keel.services.model.pricing import PriceTable


def _pipeline() -> Graph:
    # 4 llm steps; priced so each call costs $1.50 -> a ~$6 pipeline.
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP, config={"model": "mock:test"})
             for i in range(4)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(3)]
    return Graph(graph_id="pricey", nodes=nodes, edges=edges)


def _expensive_table() -> PriceTable:
    # mock:test priced high: 10 in / 5 out tokens -> $1.50 per call
    return PriceTable(prices={"mock:test": (100.0, 100.0)})


@pytest.mark.asyncio
async def test_two_dollar_budget_pauses_then_raise_resumes():
    runner = await Runner.open(in_memory=True, model=MockModelPort(),
                               price_table=_expensive_table(),
                               budget=Budget(max_usd=2.0, action=BudgetAction.PAUSE))
    paused = await runner.run(_pipeline(), run_id="p")
    assert paused.status == "paused"
    # It stopped within one step boundary of the $2 limit, not after spending all ~$6.
    assert paused.total_cost_usd <= 3.0
    completed_at_pause = sum(1 for r in paused.steps.values() if r.status == "completed")
    assert 0 < completed_at_pause < 4

    # Raise the budget and resume — it continues from the boundary with full state.
    runner.budget = Budget(max_usd=100.0, action=BudgetAction.PAUSE)
    final = await runner.resume("p")
    await runner.close()
    assert final.status == "completed"
    assert all(r.status == "completed" for r in final.steps.values())
    # No re-billing of the steps completed before the pause.
    assert final.total_cost_usd == pytest.approx(4 * 1.5, abs=1e-6)
