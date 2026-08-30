"""The one-call durable runtime — the embodiment of invariant #5 (the simple path
is the safe path). ``Runner.open()`` gives you tracing, a durable event store, a
content-addressed blob store, a default budget, and the full node-handler table,
all on, with no "production mode" toggle. ``run`` and ``resume`` are the same fold
underneath; ``resume`` recovers the graph from the catalog and continues the
frontier without re-billing completed steps.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..executor.effects import EffectLedger
from ..executor.engine import Executor, RunContext, StepInterceptor
from ..executor.state import RunState
from ..kir.schema import Graph
from ..substrate.catalog import MemoryRunCatalog, RunCatalog, RunInfo, SqliteRunCatalog
from ..substrate.events import Event
from ..substrate.ports import (
    BlobStore,
    Clock,
    FileBlobStore,
    IdGen,
    MemoryBlobStore,
    Rng,
    SeededRng,
    SystemClock,
    UlidIdGen,
)
from ..substrate.redact import Redactor
from ..substrate.store.base import EventStore
from ..substrate.store.memory import MemoryEventStore
from ..substrate.store.sqlite import SqliteEventStore
from ..substrate.tracebus import EventListener, OTelExporter, TraceBus
from .budget import Budget, Budgeter, BudgetInterceptor
from .gate_service import GateService
from .model.handlers import Completer
from .model.port import ModelPort
from .model.router import Router
from .nodes import default_handlers
from .pharos import PharosConfig, PharosGovernance
from .scheduler import Scheduler
from .tools.gateway import ToolGateway


class RunIdConflictError(ValueError):
    """A caller tried to reuse a claimed run id for different logical work."""


@dataclass
class Runner:
    store: EventStore
    catalog: RunCatalog
    blobs: BlobStore
    handlers: dict[Any, Any]
    clock: Clock
    ids: IdGen
    rng: Rng
    budget: Budget
    redactor: Redactor
    otel: OTelExporter | None = None
    listeners: list[EventListener] | None = None
    tenant: str | None = None
    tenant_budget: Budget | None = None
    governance: PharosGovernance | None = None
    _owns: bool = True

    @classmethod
    async def open(
        cls,
        *,
        db_path: str | None = "keel.db",
        blob_dir: str | None = "blobs",
        in_memory: bool = False,
        model: ModelPort | None = None,
        completer: Completer | None = None,
        router: Router | None = None,
        gateway: ToolGateway | None = None,
        budget: Budget | None = None,
        redactor: Redactor | None = None,
        otel: OTelExporter | None = None,
        listeners: list[EventListener] | None = None,
        tenant: str | None = None,
        tenant_budget: Budget | None = None,
        pharos: PharosConfig | None = None,
        price_table: Any = None,
        seed: int = 0,
        clock: Clock | None = None,
        ids: IdGen | None = None,
    ) -> Runner:
        if in_memory:
            store: EventStore = MemoryEventStore()
            catalog: RunCatalog = MemoryRunCatalog()
            blobs: BlobStore = MemoryBlobStore()
        else:
            assert db_path and blob_dir
            sqlite_store = await SqliteEventStore(db_path).open()
            store = sqlite_store
            catalog = await SqliteRunCatalog(conn=sqlite_store.conn).open()
            blobs = FileBlobStore(blob_dir)
        handlers = default_handlers(
            model=model,
            completer=completer,
            router=router,
            gateway=gateway,
            price_table=price_table,
        )
        return cls(
            store=store,
            catalog=catalog,
            blobs=blobs,
            handlers=handlers,
            clock=clock or SystemClock(),
            ids=ids or UlidIdGen(),
            rng=SeededRng(seed),
            budget=budget or Budget.default(),
            redactor=redactor or Redactor(),
            otel=otel,
            listeners=listeners,
            tenant=tenant,
            tenant_budget=tenant_budget,
            governance=PharosGovernance(pharos) if pharos is not None else None,
        )

    def _new_bus(self) -> TraceBus:
        return TraceBus(self.store, self.redactor, self.otel, listeners=self.listeners)

    def _run_scope(self, rid: str) -> str:
        return f"tenant:{self.tenant}/run:{rid}" if self.tenant else f"run:{rid}"

    def _build_budgeter(self, rid: str, state: RunState | None = None) -> Budgeter:
        budgeter = Budgeter(self.clock)
        scope = self._run_scope(rid)
        if self.tenant and self.tenant_budget is not None:
            budgeter.register(f"tenant:{self.tenant}", self.tenant_budget)
        budgeter.register(scope, self.budget)
        if state is not None:
            # Re-load committed spend so budgets stay honest across resume.
            budgeter.commit_spend(
                f"{scope}/node:_seed",
                state.total_cost_usd,
                state.total_tokens_in + state.total_tokens_out,
            )
            for _ in range(
                sum(1 for r in state.steps.values() if r.status in ("completed", "skipped"))
            ):
                budgeter.commit_step(f"{scope}/node:_seed")
        return budgeter

    async def register(self, graph: Graph, *, run_id: str | None = None) -> str:
        """Record a run's graph in the catalog without executing it, so a worker can
        later pick it up by id (``resume`` recovers the graph). Returns the run id."""
        rid = run_id or self.ids.new()
        await self.catalog.record_run(
            rid,
            graph.graph_id,
            graph.model_dump_json(),
            self.clock.now().isoformat(),
            self.tenant or "",
        )
        return rid

    async def run(self, graph: Graph, *, run_id: str | None = None) -> RunState:
        rid = run_id or self.ids.new()
        await self.catalog.record_run(
            rid,
            graph.graph_id,
            graph.model_dump_json(),
            self.clock.now().isoformat(),
            self.tenant or "",
        )
        return await self._execute_registered(graph, rid)

    async def run_once(
        self, graph: Graph, *, run_id: str, claim_graph_id: str | None = None
    ) -> tuple[RunState, bool]:
        """Atomically admit a stable run id once.

        Returns ``(state, replayed)``. A repeated claim never executes the graph a
        second time; it returns the currently durable folded state. ``claim_graph_id``
        lets an integration bind the id to a request fingerprint and fail closed if
        the same id is reused for different work.
        """
        claim = claim_graph_id or graph.graph_id
        claimed = await self.catalog.claim_run(
            run_id, claim, graph.model_dump_json(), self.clock.now().isoformat(), self.tenant or ""
        )
        if not claimed:
            existing = await self.catalog.get_run(run_id)
            if existing is None or existing.graph_id != claim:
                raise RunIdConflictError(f"run id '{run_id}' is already bound to different work")
            return await self.load_state(run_id), True
        return await self._execute_registered(graph, run_id), False

    async def _execute_registered(self, graph: Graph, rid: str) -> RunState:
        scope = self._run_scope(rid)
        budgeter = self._build_budgeter(rid)
        bus = self._new_bus()
        await bus.start()
        state = RunState(run_id=rid, graph=graph)
        ctx = RunContext(
            rid,
            self.clock,
            self.ids,
            self.rng,
            self.blobs,
            bus,
            state,
            scope=scope,
            budgeter=budgeter,
            ledger=EffectLedger([], self.blobs),
        )  # fresh run: nothing to replay
        try:
            interceptors: list[StepInterceptor] = [BudgetInterceptor(budgeter)]
            if self.governance is not None:
                interceptors.append(self.governance)
            final = await Executor(self.store, bus, self.blobs, self.handlers, interceptors).run(
                graph, ctx
            )
        finally:
            await bus.flush()
            await bus.close()
        return final

    async def resume(self, run_id: str) -> RunState:
        graph_json = await self.catalog.get_graph(run_id)
        if graph_json is None:
            raise KeyError(f"no graph recorded for run '{run_id}' (cannot resume)")
        graph = Graph.model_validate_json(graph_json)
        events = [e async for e in self.store.read_run(run_id)]
        state = RunState.fold(run_id, graph, events)
        if state.status in ("completed", "failed", "cancelled"):
            return state  # terminal — nothing to resume
        scope = self._run_scope(run_id)
        budgeter = self._build_budgeter(run_id, state)
        bus = self._new_bus()
        await bus.start()
        ctx = RunContext(
            run_id,
            self.clock,
            self.ids,
            self.rng,
            self.blobs,
            bus,
            state,
            scope=scope,
            budgeter=budgeter,
            ledger=EffectLedger(events, self.blobs),
        )  # replay committed effects
        try:
            interceptors: list[StepInterceptor] = [BudgetInterceptor(budgeter)]
            if self.governance is not None:
                interceptors.append(self.governance)
            final = await Executor(self.store, bus, self.blobs, self.handlers, interceptors).resume(
                graph, ctx
            )
        finally:
            await bus.flush()
            await bus.close()
        return final

    async def load_state(self, run_id: str) -> RunState:
        graph_json = await self.catalog.get_graph(run_id)
        if graph_json is None:
            raise KeyError(f"unknown run '{run_id}'")
        graph = Graph.model_validate_json(graph_json)
        events = [e async for e in self.store.read_run(run_id)]
        return RunState.fold(run_id, graph, events)

    async def read_events(self, run_id: str) -> list[Event]:
        return [e async for e in self.store.read_run(run_id)]

    def gate_service(self, scheduler: Scheduler | None = None) -> GateService:
        return GateService(self.store, self.ids, self.clock, self.blobs, scheduler)

    async def approve_gate(self, run_id: str, node_id: str, payload: bytes | None = None) -> None:
        """Append a GATE_APPROVED decision. Resuming the run then completes the gate
        from any worker — it needs neither the original process nor machine."""
        await self.gate_service().approve(run_id, node_id, payload)

    async def reject_gate(self, run_id: str, node_id: str) -> None:
        await self.gate_service().reject(run_id, node_id)

    async def list_runs(self, limit: int = 100) -> list[RunInfo]:
        return await self.catalog.list_runs(limit)

    async def close(self) -> None:
        if not self._owns:
            return
        if self.governance is not None:
            await self.governance.close()
        if isinstance(self.store, SqliteEventStore):
            await self.store.close()
        if isinstance(self.catalog, SqliteRunCatalog):
            await self.catalog.close()
