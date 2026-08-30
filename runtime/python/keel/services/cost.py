"""Cross-run cost rollup (P3-7).

Aggregates spend over recorded runs from the event log + catalog: by graph, model,
node, tenant, and day, plus a most-expensive-step board. Like everything else, it is
a projection over the events — there is no separate billing pipeline to reconcile.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from ..substrate.store.base import EventStore
from ..substrate.catalog import RunCatalog


@dataclass
class CostRollup:
    by_graph: dict[str, float] = field(default_factory=dict)
    by_model: dict[str, float] = field(default_factory=dict)
    by_node: dict[str, float] = field(default_factory=dict)
    by_tenant: dict[str, float] = field(default_factory=dict)
    by_day: dict[str, float] = field(default_factory=dict)
    total_usd: float = 0.0
    most_expensive: list[dict[str, object]] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "total_usd": self.total_usd, "by_graph": self.by_graph,
            "by_model": self.by_model, "by_node": self.by_node,
            "by_tenant": self.by_tenant, "by_day": self.by_day,
            "most_expensive": self.most_expensive,
        }


def _bump(d: dict[str, float], key: str, amt: float) -> None:
    d[key] = d.get(key, 0.0) + amt


async def cost_rollup(store: EventStore, catalog: RunCatalog, *, limit: int = 500,
                      top_n: int = 10) -> CostRollup:
    roll = CostRollup()
    steps: list[dict[str, object]] = []
    for info in await catalog.list_runs(limit):
        day = info.created_at[:10]
        tenant = info.tenant or "-"
        per_node: dict[str, float] = {}
        async for e in store.read_run(info.run_id):
            if not e.cost_usd:
                continue
            model = (e.tokens.model if e.tokens else "") or "-"
            node = e.node_id or "-"
            roll.total_usd += e.cost_usd
            _bump(roll.by_graph, info.graph_id, e.cost_usd)
            _bump(roll.by_model, model, e.cost_usd)
            _bump(roll.by_node, f"{info.graph_id}.{node}", e.cost_usd)
            _bump(roll.by_tenant, tenant, e.cost_usd)
            _bump(roll.by_day, day, e.cost_usd)
            _bump(per_node, node, e.cost_usd)
        for node, usd in per_node.items():
            steps.append({"run_id": info.run_id, "graph_id": info.graph_id,
                          "node_id": node, "usd": usd})
    steps.sort(key=lambda s: float(s["usd"]), reverse=True)  # type: ignore[arg-type]
    roll.most_expensive = steps[:top_n]
    return roll
