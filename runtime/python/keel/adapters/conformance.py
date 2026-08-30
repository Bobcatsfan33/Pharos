"""The shared adapter conformance contract (M4).

Every adapter, given a framework agent, must produce a KEEL run that is: (1) recorded
(model calls emit ``llm.request``/``llm.response``), (2) budget-governed, and (3)
replayable byte-identically. ``assert_conforms`` runs all three checks against the
``AgentNode`` graph an adapter built — so one suite covers every adapter.
"""
from __future__ import annotations
from dataclasses import dataclass
from ..substrate.events import EventType
from ..services.model.port import ModelPort
from ..services.model.pricing import PriceTable
from .base import AgentNode, run_agent, replay_agent


@dataclass
class ConformanceReport:
    recorded_calls: int
    cost_usd: float
    replay_identical: bool
    completed: bool

    @property
    def ok(self) -> bool:
        return self.recorded_calls > 0 and self.replay_identical and self.completed


async def assert_conforms(graph_id: str, nodes: list[AgentNode], *, model: ModelPort,
                          price_table: PriceTable | None = None) -> ConformanceReport:
    table = price_table or PriceTable()
    run = await run_agent(graph_id, nodes, model=model, price_table=table, in_memory=True)
    events = [e async for e in run.store.read_run(run.run_id)]
    recorded_calls = sum(1 for e in events if e.type == EventType.LLM_RESPONSE)
    identical = await replay_agent(graph_id, nodes, run.run_id, events, run.blobs,
                                   price_table=table)
    return ConformanceReport(
        recorded_calls=recorded_calls,
        cost_usd=run.state.total_cost_usd,
        replay_identical=identical,
        completed=run.state.status == "completed",
    )
