"""P2-10: a 10k-event run's detail endpoint renders well under 2s. Runnable as a
gate (`python -m tests.chaos.bench_viewer`) and as a pytest (skipped without the
viewer extra)."""
import asyncio
import sys
import tempfile
import time
from pathlib import Path

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.budget import Budget, BudgetAction
from keel.services.model.handlers import MockModelPort

RENDER_BUDGET_S = 2.0
# explicit unlimited spend budget for the big benchmark run
_UNLIMITED = Budget(max_usd=None, max_steps=None, action=BudgetAction.WARN)


def _big_chain(nodes: int) -> Graph:
    ns = [Node(id=f"s{i}", type=NodeType.LLM_STEP, config={"model": "mock:test"})
          for i in range(nodes)]
    es = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(nodes - 1)]
    return Graph(graph_id="big", nodes=ns, edges=es)


async def measure(nodes: int = 1800, root: str | None = None) -> tuple[int, float]:
    tmp = root or tempfile.mkdtemp(prefix="keel-bench-")
    db, blob_dir = str(Path(tmp) / "k.db"), str(Path(tmp) / "blobs")
    runner = await Runner.open(db_path=db, blob_dir=blob_dir, model=MockModelPort(),
                               budget=_UNLIMITED)
    await runner.run(_big_chain(nodes), run_id="big")  # ~5 events/step => ~9k events
    n_events = len(await runner.read_events("big"))
    await runner.close()

    from fastapi.testclient import TestClient
    from keel.viewer.app import create_app
    with TestClient(create_app(db, blob_dir)) as client:
        t0 = time.perf_counter()
        resp = client.get("/api/runs/big")
        elapsed = time.perf_counter() - t0
        assert resp.status_code == 200
    return n_events, elapsed


async def main() -> int:
    n, elapsed = await measure()
    print(f"viewer render: {n} events in {elapsed*1000:.0f}ms (budget {RENDER_BUDGET_S*1000:.0f}ms)")
    return 0 if elapsed < RENDER_BUDGET_S else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
