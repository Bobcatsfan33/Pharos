from __future__ import annotations
import asyncio
import math
from typing import Optional, Callable, Awaitable, Any, Protocol, runtime_checkable
from ..substrate.events import Event, EventType, TokenUsage
from ..substrate.ports import Clock, IdGen, Rng, BlobStore
from ..substrate.tracebus import TraceBus
from ..substrate.store.base import EventStore
from ..kir.schema import Graph, Node, NodeType
from .state import RunState
from .effects import EffectLedger


class RetryableError(Exception):
    def __init__(self, msg: str, taxonomy: str = "transient") -> None:
        super().__init__(msg)
        self.taxonomy = taxonomy


class FatalError(Exception):
    pass


class GatePaused(Exception):
    """Unwinds the run loop cleanly without failing it. The run is *parked* in the
    log with zero compute until an external event (gate approval, budget raise)
    re-enqueues it. Defined here so both the executor and the gate/budget handlers
    can reference it without an import cycle."""


@runtime_checkable
class SpendMeter(Protocol):
    """Just the chokepoint method the context needs — the L3 Budgeter satisfies it.
    Keeping this protocol in L2 lets emit meter spend without importing services."""

    def commit_spend(self, node_scope: str, usd: float, tokens: int) -> None: ...


class RunContext:
    """One per run. Holds the injected ports so nothing below calls a clock, rng,
    or id generator directly. During replay these are the Replay* variants. The
    optional ``scope`` prefix is what the budgeter charges spend against."""

    def __init__(self, run_id: str, clock: Clock, ids: IdGen, rng: Rng,
                 blobs: BlobStore, bus: TraceBus, state: RunState,
                 scope: Optional[str] = None, budgeter: Optional["SpendMeter"] = None,
                 ledger: Optional["EffectLedger"] = None) -> None:
        self.run_id = run_id
        self.clock = clock
        self.ids = ids
        self.rng = rng
        self.blobs = blobs
        self.bus = bus
        self.state = state
        self.scope = scope or f"run:{run_id}"
        # The budgeter (a SpendMeter) is metered at the single chokepoint all spend
        # flows through — this emit — so there is no path (retries, crew regions)
        # that can spend without being counted. None disables metering.
        self.budgeter = budgeter
        # The effect ledger replays committed model/tool calls on resume instead of
        # re-issuing them (side-effect-once). Empty on a fresh run.
        self.ledger = ledger

    def scope_for(self, node_id: str) -> str:
        return f"{self.scope}/node:{node_id}"

    async def emit(self, type: EventType, *, node_id: Optional[str] = None,
                   attempt: int = 1, payload: Optional[bytes] = None,
                   tokens: Optional[TokenUsage] = None, cost_usd: float = 0.0,
                   data: Optional[dict[str, Any]] = None) -> Event:
        ref = self.blobs.put(payload) if payload is not None else None
        ev = Event(
            event_id=self.ids.new(),
            run_id=self.run_id,
            seq=self.state.next_seq,
            ts=self.clock.now(),
            type=type,
            node_id=node_id,
            attempt=attempt,
            payload_ref=ref,
            tokens=tokens,
            cost_usd=cost_usd,
            data=data or {},
        )
        # Fold locally FIRST (advances seq), then persist. A crash in the gap leaves
        # the persisted log gap-free; the un-persisted event is regenerated on resume.
        self.state._apply(ev)
        # Meter spend at the chokepoint: any event carrying cost/tokens is charged to
        # its node's scope (and thereby every ancestor scope). Retries and crew-region
        # spend cannot bypass this because they, too, flow through emit.
        if self.budgeter is not None and node_id is not None and (cost_usd or tokens):
            tok = (tokens.input + tokens.output) if tokens is not None else 0
            self.budgeter.commit_spend(self.scope_for(node_id), cost_usd, tok)
        await self.bus.emit(ev)
        return ev


NodeHandler = Callable[["RunContext", Node, dict[str, bytes]], Awaitable[bytes]]


@runtime_checkable
class StepInterceptor(Protocol):
    """Cross-cutting hook around every step. Used by the budgeter (L3) to enforce
    spend limits without the executor (L2) importing it. ``before_step`` may raise
    ``GatePaused`` to park the run or ``FatalError`` to kill it."""

    async def before_step(self, ctx: RunContext, node: Node) -> Node | None: ...
    async def after_step(self, ctx: RunContext, node: Node, cost_usd: float,
                         tokens_in: int, tokens_out: int) -> None: ...


class Executor:
    def __init__(self, store: EventStore, bus: TraceBus, blobs: BlobStore,
                 handlers: dict[NodeType, NodeHandler],
                 interceptors: Optional[list[StepInterceptor]] = None) -> None:
        self._store = store
        self._bus = bus
        self._blobs = blobs
        self._handlers = handlers
        self._interceptors = interceptors or []

    async def run(self, graph: Graph, ctx: RunContext) -> RunState:
        st = ctx.state
        if st.status == "pending":
            await ctx.emit(EventType.RUN_STARTED)
        elif st.status in ("running", "paused"):
            await ctx.emit(EventType.RUN_RESUMED)

        while True:
            frontier = st.frontier()
            if not frontier:
                break
            await asyncio.gather(*(self._run_node(graph, ctx, nid) for nid in frontier))
            if st.status in ("paused", "failed", "cancelled"):
                return st

        await ctx.emit(EventType.RUN_COMPLETED)
        return st

    async def resume(self, graph: Graph, ctx: RunContext) -> RunState:
        """Alias that makes the intent explicit at call sites. Resume and a fresh
        run are the *same* code path — both fold, then schedule the frontier."""
        return await self.run(graph, ctx)

    async def _run_node(self, graph: Graph, ctx: RunContext, node_id: str) -> None:
        node = self._node(graph, node_id)
        rec = ctx.state.steps.get(node_id)
        attempt = (rec.attempt + 1) if rec and rec.status == "started" else 1

        # Branch not taken: mark skipped (propagates to its successors via the fold).
        if (rec is None or rec.status != "started") and ctx.state.should_skip(node_id):
            await ctx.emit(EventType.STEP_SKIPPED, node_id=node_id)
            return

        # Cross-cutting gate (budget, policy) BEFORE any work is scheduled.
        try:
            for interceptor in self._interceptors:
                replacement = await interceptor.before_step(ctx, node)
                if replacement is not None:
                    if replacement.id != node.id or replacement.type != node.type:
                        raise FatalError("an interceptor cannot change a step's id or type")
                    node = replacement
        except GatePaused:
            return  # status already set to paused by the interceptor
        except FatalError as err:
            await self._fail_node(ctx, node_id, attempt, "permanent", str(err))
            return

        await ctx.emit(EventType.STEP_SCHEDULED, node_id=node_id, attempt=attempt)
        await ctx.emit(EventType.STEP_STARTED, node_id=node_id, attempt=attempt)

        handler = self._handlers[node.type]
        inputs = self._gather_inputs(graph, ctx, node)
        cost_before = ctx.state.total_cost_usd
        tin_before, tout_before = ctx.state.total_tokens_in, ctx.state.total_tokens_out
        try:
            result_bytes = await handler(ctx, node, inputs)
        except GatePaused:
            return  # human_gate / budget pause: run parked, not failed
        except RetryableError as err:
            if attempt <= node.retry.max:
                await ctx.emit(EventType.STEP_RETRIED, node_id=node_id, attempt=attempt,
                               data={"reason": err.taxonomy})
                await self._backoff(node, attempt)
                return await self._run_node(graph, ctx, node_id)
            await self._fail_node(ctx, node_id, attempt, err.taxonomy, str(err))
            return
        except FatalError as err:
            await self._fail_node(ctx, node_id, attempt, "permanent", str(err))
            return
        except Exception as err:  # noqa: BLE001 — invariant #1: no silent crash
            await self._fail_node(ctx, node_id, attempt, "internal",
                                  f"{type(err).__name__}: {err}")
            return

        await ctx.emit(EventType.STEP_COMPLETED, node_id=node_id, attempt=attempt,
                       payload=result_bytes)
        for interceptor in self._interceptors:
            await interceptor.after_step(
                ctx, node,
                ctx.state.total_cost_usd - cost_before,
                ctx.state.total_tokens_in - tin_before,
                ctx.state.total_tokens_out - tout_before,
            )

    async def _fail_node(self, ctx: RunContext, node_id: str, attempt: int,
                         taxonomy: str, msg: str) -> None:
        await ctx.emit(EventType.STEP_FAILED, node_id=node_id, attempt=attempt,
                       data={"error": {"type": taxonomy, "msg": msg}})
        await ctx.emit(EventType.RUN_FAILED)
        ctx.state.status = "failed"

    @staticmethod
    def _node(graph: Graph, node_id: str) -> Node:
        return next(n for n in graph.nodes if n.id == node_id)

    def _gather_inputs(self, graph: Graph, ctx: RunContext, node: Node) -> dict[str, bytes]:
        """Pull predecessors' completed outputs from the blob store. A resumed run
        reads them back instead of recomputing — the 'never re-billed' guarantee."""
        preds = [e.from_ for e in graph.edges if e.to == node.id]
        out: dict[str, bytes] = {}
        for p in preds:
            rec = ctx.state.steps.get(p)
            if rec and rec.result_ref:
                out[p] = ctx.blobs.get(rec.result_ref)
        return out

    async def _backoff(self, node: Node, attempt: int) -> None:
        if node.retry.backoff == "none":
            return
        base = 0.5
        delay = base * attempt if node.retry.backoff == "linear" else base * math.pow(2, attempt)
        await asyncio.sleep(delay)
