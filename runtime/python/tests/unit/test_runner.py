"""Runner: defaults-on durable runtime, gate approve -> resume, resume idempotence."""
import pytest

from keel.authoring import Agent, Task, Crew
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.budget import Budget, BudgetAction


def _crew():
    a = Agent("researcher", goal="research")
    b = Agent("editor", goal="approve")
    c = Agent("writer", goal="write")
    t1 = Task("Research", agent=a)
    gate = Task("Approve", agent=b, human_gate=True, context=[t1])
    t2 = Task("Write", agent=c, context=[gate])
    return Crew("rp", tasks=[t1, gate, t2])


@pytest.mark.asyncio
async def test_run_completes_with_defaults_on():
    runner = await Runner.open(in_memory=True, model=MockModelPort())
    a = Agent("r", goal="g")
    graph = Crew("g", tasks=[Task("do it", agent=a)]).compile()
    state = await runner.run(graph, run_id="r1")
    await runner.close()
    assert state.status == "completed"


@pytest.mark.asyncio
async def test_gate_pause_then_approve_resume_no_rebill():
    model = MockModelPort()
    runner = await Runner.open(in_memory=True, model=model)
    graph = _crew().compile()
    s1 = await runner.run(graph, run_id="r2")
    assert s1.status == "paused"
    calls_at_pause = model.calls
    assert calls_at_pause == 1  # only the research step ran

    await runner.approve_gate("r2", "approve")
    s2 = await runner.resume("r2")
    await runner.close()
    assert s2.status == "completed"
    # research not re-billed; only the writer step added a call.
    assert model.calls == 2


@pytest.mark.asyncio
async def test_resume_of_completed_run_is_noop():
    runner = await Runner.open(in_memory=True, model=MockModelPort())
    a = Agent("r", goal="g")
    graph = Crew("g", tasks=[Task("do it", agent=a)]).compile()
    await runner.run(graph, run_id="r3")
    again = await runner.resume("r3")
    await runner.close()
    assert again.status == "completed"


@pytest.mark.asyncio
async def test_budget_pause_then_raise_and_resume():
    # $-style demo: a tight step budget pauses; raising it and resuming completes.
    model = MockModelPort()
    runner = await Runner.open(in_memory=True, model=model,
                               budget=Budget(max_steps=1, action=BudgetAction.PAUSE))
    a, b = Agent("a", goal="g"), Agent("b", goal="g")
    t1 = Task("one", agent=a)
    t2 = Task("two", agent=b, context=[t1])
    graph = Crew("bp", tasks=[t1, t2]).compile()
    s1 = await runner.run(graph, run_id="r4")
    assert s1.status == "paused"
    # raise the budget and resume from the same boundary
    runner.budget = Budget(max_steps=10, action=BudgetAction.PAUSE)
    s2 = await runner.resume("r4")
    await runner.close()
    assert s2.status == "completed"
