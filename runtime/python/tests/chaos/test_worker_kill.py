"""P2-2: worker leasing + scheduler.

Proves the mechanisms the production soak (N workers, random kills, 500 concurrent,
1h) relies on, deterministically:
  * a dead worker's lease is stolen after its TTL;
  * at-least-once delivery is idempotent — the lease ensures a run is advanced once,
    and a duplicate delivery of an already-finished run re-bills nothing;
  * every run's log stays sound (gap-free seq, no orphaned started steps) under a
    concurrent worker pool.
"""
import asyncio
import pytest

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.substrate.ports import SystemClock
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.scheduler import MemoryScheduler
from keel.services.worker import LeasedRunLoop
from keel.executor.lease import MemoryLeaseManager
from tests.chaos.invariant_checker import assert_run_log_sound


def _chain(graph_id: str, n: int = 4) -> Graph:
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP, config={"model": "mock:test"})
             for i in range(n)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(n - 1)]
    return Graph(graph_id=graph_id, nodes=nodes, edges=edges)


class _ManualClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self):  # pragma: no cover - unused here
        from datetime import datetime, timezone
        return datetime.now(timezone.utc)

    def monotonic(self) -> float:
        return self.t


@pytest.mark.asyncio
async def test_expired_lease_is_stolen():
    clock = _ManualClock()
    leases = MemoryLeaseManager(clock, ttl_s=10)
    assert await leases.acquire("run", "w1") is True
    assert await leases.acquire("run", "w2") is False  # w1 holds it
    clock.t = 11  # w1's lease expires (w1 presumed dead, never released)
    assert await leases.acquire("run", "w2") is True   # w2 steals it
    assert leases.holder("run") == "w2"


@pytest.mark.asyncio
async def test_concurrent_pool_at_least_once_no_rebill_sound_logs():
    model = MockModelPort()
    runner = await Runner.open(in_memory=True, model=model)
    scheduler = MemoryScheduler()
    leases = MemoryLeaseManager(SystemClock(), ttl_s=60)

    K, NODES, WORKERS, DELIVERIES = 12, 4, 4, 2
    graphs = {}
    for i in range(K):
        g = _chain(f"g{i}", NODES)
        rid = f"run{i}"
        graphs[rid] = g
        await runner.register(g, run_id=rid)
        for _ in range(DELIVERIES):  # at-least-once: deliver each run more than once
            await scheduler.enqueue(rid)

    remaining = [K * DELIVERIES]  # total items to drain across the pool

    async def worker(wid: str) -> None:
        loop = LeasedRunLoop(runner, scheduler, leases, wid, heartbeat_s=0.05)
        while remaining[0] > 0:
            remaining[0] -= 1
            await loop.serve_once()  # real leased path: dequeue -> acquire -> resume

    await asyncio.gather(*(worker(f"w{i}") for i in range(WORKERS)))

    # Every run completed.
    for rid, g in graphs.items():
        state = await runner.load_state(rid)
        assert state.status == "completed", f"{rid} -> {state.status}"
        await assert_run_log_sound(runner.store, rid, g)

    # No re-billing: each run's NODES llm steps ran exactly once despite each run
    # being delivered twice (the second delivery resumed an already-completed run).
    assert model.calls == K * NODES, model.calls
    await runner.close()
