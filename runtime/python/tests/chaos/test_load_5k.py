"""P4-8: load test — many runs complete with zero data loss and sound logs. The
in-suite check uses a scaled count; `python -m tests.chaos.test_load_5k` runs the
full 5k (the 24h soak is an infra job)."""
import asyncio
import sys

import pytest

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from tests.chaos.invariant_checker import assert_run_log_sound


def _graph() -> Graph:
    return Graph(graph_id="load",
                 nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
                        Node(id="b", type=NodeType.LLM_STEP, config={"model": "mock:test"})],
                 edges=[Edge.model_validate({"from": "a", "to": "b"})])


async def run_load(n: int, concurrency: int = 50) -> tuple[int, int]:
    runner = await Runner.open(in_memory=True, model=MockModelPort())
    graph = _graph()
    sem = asyncio.Semaphore(concurrency)
    completed = 0

    async def one(i: int) -> None:
        nonlocal completed
        async with sem:
            state = await runner.run(graph, run_id=f"load-{i}")
            if state.status == "completed":
                completed += 1

    await asyncio.gather(*(one(i) for i in range(n)))
    # zero data loss: every run is present and its log is sound
    sound = 0
    for i in range(n):
        await assert_run_log_sound(runner.store, f"load-{i}", graph)
        sound += 1
    await runner.close()
    return completed, sound


@pytest.mark.asyncio
async def test_load_no_data_loss():
    n = 600
    completed, sound = await run_load(n, concurrency=40)
    assert completed == n, f"only {completed}/{n} completed"
    assert sound == n, f"only {sound}/{n} logs sound"


async def _main() -> int:
    n = 5000
    completed, sound = await run_load(n, concurrency=64)
    print(f"load: {completed}/{n} completed, {sound}/{n} logs sound")
    return 0 if completed == n and sound == n else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
