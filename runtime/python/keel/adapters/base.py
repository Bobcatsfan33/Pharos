"""Adapter architecture (M4) — be the runtime *under* the frameworks.

The single conformance contract every adapter satisfies: express the framework's agent
as a graph of ``AgentNode``s whose model calls go through a ``TracedModel``. KEEL's
executor then drives that graph, so the framework's run gains durability, tracing,
budgets, and byte-identical replay **without the user rewriting their graph** — the
adapter does the translation.

  * ``TracedModel`` — the interception point. A framework node calls ``.complete()``
    on it instead of its own LLM client; each call emits ``llm.request``/``llm.response``
    (tokens + cost), is metered against the budget, and is replay-safe: a call already
    committed to the log is replayed from the effect ledger, not re-issued or re-billed.
  * ``AgentNode`` — one framework step: an id, a coroutine ``run(model, inputs)`` that
    does the step's work (calling ``model`` for any LLM), and its dependencies.
  * ``run_agent`` / ``replay_agent`` — execute the agent graph on KEEL, and re-drive a
    recorded run byte-identically.

What an adapter intercepts (model + tool calls routed through KEEL) and what it does
not (framework-internal nondeterminism KEEL can't see) is documented per adapter.
"""
from __future__ import annotations
import json
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional
from ..substrate.events import Event, EventType, TokenUsage
from ..substrate.store.base import EventStore
from ..substrate.ports import BlobStore
from ..kir.schema import Graph, Node, Edge, NodeType
from ..executor.engine import RunContext, NodeHandler
from ..executor.state import RunState
from ..services.model.port import ModelPort, ModelRequest
from ..services.model.pricing import PriceTable
from ..services.runner import Runner

Messages = list[dict[str, str]]


class TracedModel:
    """KEEL-backed model the framework uses. Records, budgets, and replays calls."""

    def __init__(self, ctx: RunContext, node: Node, model: ModelPort,
                 table: PriceTable) -> None:
        self._ctx = ctx
        self._node = node
        self._model = model
        self._table = table
        self._calls = 0
        self._recorded = ctx.ledger.recorded_model_responses(node.id) if ctx.ledger else []

    async def complete(self, messages: Messages, *, model: Optional[str] = None,
                       max_tokens: int = 1024) -> str:
        i = self._calls
        self._calls += 1
        if i < len(self._recorded):
            return self._recorded[i].text  # replay a committed call: no re-issue, no re-bill
        req = ModelRequest(model=model or str(self._node.config.get("model", "mock:test")),
                           messages=messages, max_tokens=max_tokens)
        await self._ctx.emit(EventType.LLM_REQUEST, node_id=self._node.id,
                             payload=json.dumps(messages).encode(),
                             data={"model": req.model, "adapter": True})
        resp = await self._model.complete(req)
        await self._ctx.emit(
            EventType.LLM_RESPONSE, node_id=self._node.id, payload=resp.text.encode(),
            tokens=TokenUsage(input=resp.tokens_in, output=resp.tokens_out, model=resp.model),
            cost_usd=self._table.cost(resp))
        return resp.text


NodeRun = Callable[[TracedModel, dict[str, bytes]], Awaitable[bytes]]


@dataclass
class AgentNode:
    id: str
    run: NodeRun
    deps: list[str] = field(default_factory=list)


@dataclass
class AgentRun:
    state: RunState
    run_id: str
    store: EventStore
    blobs: BlobStore


def to_graph(graph_id: str, nodes: list[AgentNode]) -> Graph:
    kir_nodes = [Node(id=n.id, type=NodeType.LLM_STEP) for n in nodes]
    edges = [Edge.model_validate({"from": dep, "to": n.id})
             for n in nodes for dep in n.deps]
    return Graph(graph_id=graph_id, nodes=kir_nodes, edges=edges)


def _adapter_handlers(by_id: dict[str, AgentNode], model: ModelPort,
                      table: PriceTable) -> dict[NodeType, NodeHandler]:
    async def handle(ctx: RunContext, node: Node, inputs: dict[str, bytes]) -> bytes:
        traced = TracedModel(ctx, node, model, table)
        return await by_id[node.id].run(traced, inputs)
    return {NodeType.LLM_STEP: handle}


async def run_agent(graph_id: str, nodes: list[AgentNode], *, model: ModelPort,
                    run_id: Optional[str] = None, price_table: Optional[PriceTable] = None,
                    in_memory: bool = True, db_path: Optional[str] = None,
                    blob_dir: Optional[str] = None) -> AgentRun:
    """Run a framework agent (expressed as AgentNodes) on KEEL — durable, traced,
    budgeted, replayable. The model calls inside each node flow through TracedModel."""
    table = price_table or PriceTable()
    by_id = {n.id: n for n in nodes}
    runner = await Runner.open(in_memory=in_memory, db_path=db_path, blob_dir=blob_dir,
                               model=model, price_table=table)
    runner.handlers = _adapter_handlers(by_id, model, table)
    graph = to_graph(graph_id, nodes)
    state = await runner.run(graph, run_id=run_id)
    return AgentRun(state=state, run_id=state.run_id, store=runner.store, blobs=runner.blobs)


async def replay_agent(graph_id: str, nodes: list[AgentNode], run_id: str,
                       events: list[Event], blobs: BlobStore,
                       price_table: Optional[PriceTable] = None) -> bool:
    """Re-drive a recorded agent run with recorded model outputs; True iff the
    re-emitted log is byte-identical to the recording. ``price_table`` must match the
    one the run used (cost is recomputed from recorded tokens)."""
    from ..substrate.ports import ReplayClock, ReplayIdGen, SeededRng
    from ..substrate.store.memory import MemoryEventStore
    from ..substrate.tracebus import TraceBus
    from ..executor.engine import Executor
    from ..services.replay import RecordedModelPort, _recorded_responses

    model = RecordedModelPort(_recorded_responses(events, blobs))
    handlers = _adapter_handlers({n.id: n for n in nodes}, model, price_table or PriceTable())
    graph = to_graph(graph_id, nodes)
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    ctx = RunContext(run_id, ReplayClock([e.ts for e in events]),
                     ReplayIdGen([e.event_id for e in events]), SeededRng(0), blobs, bus,
                     RunState(run_id=run_id, graph=graph))
    try:
        await Executor(store, bus, blobs, handlers).run(graph, ctx)
    finally:
        await bus.flush()
        await bus.close()
    replayed = [e async for e in store.read_run(run_id)]
    return (len(replayed) == len(events)
            and all(a.to_json() == b.to_json() for a, b in zip(replayed, events)))
