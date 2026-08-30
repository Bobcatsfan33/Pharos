"""Time-travel replay (P2-6).

Every nondeterministic input was recorded through an L1 port, so a run can be
re-driven exactly. Two modes:

  * ``replay_recorded`` — feed the recorded timestamps, ids, and model/tool outputs
    back through the Replay* ports and re-run the executor. The emitted log is
    *byte-identical* to the original (any divergence means a nondeterminism leak).
  * ``replay_patched`` — seed the run up to ``from_step`` from the recorded log
    (optionally overwriting that step's output), then execute everything downstream
    LIVE. Upstream is unchanged; divergence is confined to the patched point and its
    descendants — the substrate for "what-if" debugging and for eval cases (Phase 4).

This driver lives in L3 because it assembles handlers; the pure log-level helpers
(``verify_recorded_replay``, ``diff_runs``) stay in ``executor.replay`` (L2).
"""
from __future__ import annotations
import json
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Optional, AsyncIterator, Callable, Any
from ..substrate.events import Event, EventType
from ..substrate.ports import (BlobStore, ReplayClock, ReplayIdGen, SeededRng)
from ..substrate.store.memory import MemoryEventStore
from ..substrate.tracebus import TraceBus
from ..kir.schema import Graph, NodeType
from ..executor.engine import Executor, RunContext, NodeHandler
from ..executor.state import RunState, StepRecord
from .model.port import ModelRequest, ModelResponse, ModelPort
from .nodes import default_handlers
from .tools.gateway import ToolGateway, make_tool_handler


class ReplayDivergence(Exception):
    pass


@dataclass
class ReplayResult:
    identical: bool
    detail: str
    replayed: list[Event]


class RecordedModelPort:
    """Returns recorded model responses in call order instead of hitting a provider.
    Because re-execution is deterministic, the i-th model call during replay maps to
    the i-th recorded ``llm.response``."""

    def __init__(self, responses: list[ModelResponse]) -> None:
        self._responses = responses
        self.calls = 0

    async def complete(self, req: ModelRequest) -> ModelResponse:
        if self.calls >= len(self._responses):
            raise ReplayDivergence(
                f"model called {self.calls + 1}x but only {len(self._responses)} "
                "responses were recorded (nondeterminism leak)")
        resp = self._responses[self.calls]
        self.calls += 1
        return resp

    async def stream(self, req: ModelRequest) -> AsyncIterator[str]:
        resp = await self.complete(req)
        yield resp.text

    def count_tokens(self, text: str, model: str) -> int:
        return max(1, len(text) // 4)


class RecordedToolGateway(ToolGateway):
    """Replays recorded tool calls instead of executing them: the i-th ``tool_step``
    invocation during replay re-emits the i-th recorded ``tool.request``/``tool.response``
    (payload + data verbatim) and returns the recorded output — no side effect re-runs,
    and the events match byte-for-byte (ids/timestamps come from the replay ports)."""

    def __init__(self, events: list[Event], blobs: BlobStore) -> None:
        super().__init__({})
        reqs = [e for e in events if e.type == EventType.TOOL_REQUEST]
        resps = [e for e in events if e.type == EventType.TOOL_RESPONSE]
        self._calls = [
            (blobs.get(rq.payload_ref) if rq.payload_ref else b"", dict(rq.data),
             blobs.get(rs.payload_ref) if rs.payload_ref else b"", dict(rs.data))
            for rq, rs in zip(reqs, resps)]
        self._i = 0

    async def invoke(self, ctx: RunContext, agent_id: str, tool_name: str,
                     args: dict[str, Any], node_id: str | None = None) -> bytes:
        if self._i >= len(self._calls):
            raise ReplayDivergence(
                f"tool called {self._i + 1}x but only {len(self._calls)} recorded")
        rq_payload, rq_data, rs_payload, rs_data = self._calls[self._i]
        self._i += 1
        await ctx.emit(EventType.TOOL_REQUEST, node_id=node_id, payload=rq_payload,
                       data=rq_data)
        await ctx.emit(EventType.TOOL_RESPONSE, node_id=node_id, payload=rs_payload,
                       data=rs_data)
        return rs_payload


def _recorded_responses(events: list[Event], blobs: BlobStore) -> list[ModelResponse]:
    out: list[ModelResponse] = []
    for e in events:
        if e.type != EventType.LLM_RESPONSE:
            continue
        text = blobs.get(e.payload_ref).decode() if e.payload_ref else ""
        tk = e.tokens
        out.append(ModelResponse(
            text=text,
            tokens_in=tk.input if tk else 0,
            tokens_out=tk.output if tk else 0,
            model=tk.model if tk else "",
            finish_reason="stop",
        ))
    return out


async def _drive(graph: Graph, run_id: str, ctx_factory: Callable[[TraceBus], RunContext],
                 handlers: dict[NodeType, NodeHandler], blobs: BlobStore) -> list[Event]:
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    ctx = ctx_factory(bus)
    try:
        await Executor(store, bus, blobs, handlers).run(graph, ctx)
    finally:
        await bus.flush()
        await bus.close()
    return [e async for e in store.read_run(run_id)]


async def replay_recorded(graph: Graph, run_id: str, events: list[Event],
                          blobs: BlobStore) -> ReplayResult:
    """Re-drive the run from its recorded log and assert byte-identity. Intended for
    executor-driven runs (externally-appended events such as gate decisions are a
    documented extension)."""
    recorded_ts = [e.ts for e in events]
    recorded_ids = [e.event_id for e in events]
    model = RecordedModelPort(_recorded_responses(events, blobs))
    handlers = default_handlers(model=model)
    if any(n.type == NodeType.TOOL_STEP for n in graph.nodes):
        handlers[NodeType.TOOL_STEP] = make_tool_handler(RecordedToolGateway(events, blobs))

    def factory(bus: TraceBus) -> RunContext:
        return RunContext(run_id, ReplayClock(recorded_ts), ReplayIdGen(recorded_ids),
                          SeededRng(0), blobs, bus, RunState(run_id=run_id, graph=graph))

    try:
        replayed = await _drive(graph, run_id, factory, handlers, blobs)
    except (ReplayDivergence, IndexError) as e:
        return ReplayResult(False, f"divergence: {e}", [])

    if len(replayed) != len(events):
        return ReplayResult(False, f"event count {len(replayed)} != recorded {len(events)}",
                            replayed)
    for a, b in zip(replayed, events):
        if a.to_json() != b.to_json():
            return ReplayResult(False, f"event #{a.seq} diverged", replayed)
    return ReplayResult(True, f"{len(replayed)} events byte-identical", replayed)


def _descendants(graph: Graph, start: str) -> set[str]:
    adj: dict[str, list[str]] = {n.id: [] for n in graph.nodes}
    for e in graph.edges:
        adj[e.from_].append(e.to)
    seen: set[str] = set()
    stack = list(adj[start])
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        stack.extend(adj[n])
    return seen


async def replay_patched(graph: Graph, run_id: str, events: list[Event], blobs: BlobStore,
                         *, from_step: str, patch: Optional[dict[str, object]] = None,
                         model: ModelPort, new_run_id: Optional[str] = None) -> RunState:
    """Seed everything except ``from_step``'s descendants from the recorded log
    (overwriting ``from_step``'s output with ``patch`` if given), then run downstream
    LIVE with ``model``. Returns the new run's final state."""
    original = RunState.fold(run_id, graph, events)
    descendants = _descendants(graph, from_step)
    rid = new_run_id or f"{run_id}:replay"

    seeded = RunState(run_id=rid, graph=graph, status="running")
    for nid, rec in original.steps.items():
        if nid in descendants:
            continue  # will be recomputed live
        result_ref = rec.result_ref
        if nid == from_step and patch is not None:
            result_ref = blobs.put(json.dumps(patch, sort_keys=True).encode())
        seeded.steps[nid] = StepRecord(nid, rec.status, rec.attempt, result_ref, rec.error)
    seeded.routes = dict(original.routes)

    handlers = default_handlers(model=model)  # live downstream
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    ctx = RunContext(rid, _SeqClock(), _LiveIds(), SeededRng(0), blobs, bus, seeded)
    try:
        final = await Executor(store, bus, blobs, handlers).run(graph, ctx)
    finally:
        await bus.flush()
        await bus.close()
    return final


class _LiveIds:
    """Deterministic id source for a patched replay (a fresh run id space)."""

    def __init__(self) -> None:
        self._i = 0

    def new(self) -> str:
        self._i += 1
        return f"replay-{self._i:08d}"


class _SeqClock:
    """Strictly-increasing synthetic clock for patched replays (the original
    timestamps no longer apply once we go live)."""

    _EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)

    def __init__(self) -> None:
        self._i = 0

    def now(self) -> datetime:
        self._i += 1
        return self._EPOCH + timedelta(seconds=self._i)

    def monotonic(self) -> float:
        self._i += 1
        return float(self._i)
