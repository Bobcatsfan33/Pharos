from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Any
from ..substrate.events import Event, EventType
from ..kir.schema import Graph, Edge


@dataclass
class StepRecord:
    node_id: str
    status: str
    attempt: int = 1
    result_ref: Optional[str] = None
    error: Optional[dict[str, Any]] = None


@dataclass
class RunState:
    """The authoritative current state, derived ONLY by folding events."""

    run_id: str
    graph: Graph
    steps: dict[str, StepRecord] = field(default_factory=dict)
    status: str = "pending"
    total_cost_usd: float = 0.0
    total_tokens_in: int = 0
    total_tokens_out: int = 0
    next_seq: int = 0
    recorded_ts: list[datetime] = field(default_factory=list)
    recorded_ids: list[str] = field(default_factory=list)
    gate_decisions: dict[str, str] = field(default_factory=dict)
    gate_payloads: dict[str, str] = field(default_factory=dict)
    routes: dict[str, str] = field(default_factory=dict)
    cancel_requested: bool = False

    @classmethod
    def fold(cls, run_id: str, graph: Graph, events: list[Event]) -> "RunState":
        st = cls(run_id=run_id, graph=graph)
        for e in events:
            st._apply(e)
        return st

    def _apply(self, e: Event) -> None:
        if e.seq != self.next_seq:
            raise ValueError(f"event log gap/disorder: expected seq {self.next_seq}, got {e.seq}")
        self.next_seq = e.seq + 1
        self.recorded_ts.append(e.ts)
        self.recorded_ids.append(e.event_id)

        if e.type == EventType.RUN_STARTED:
            self.status = "running"
        elif e.type == EventType.RUN_COMPLETED:
            self.status = "completed"
        elif e.type == EventType.RUN_FAILED:
            self.status = "failed"
        elif e.type == EventType.RUN_PAUSED:
            self.status = "paused"
        elif e.type == EventType.RUN_RESUMED:
            self.status = "running"
        elif e.type == EventType.STEP_SCHEDULED:
            assert e.node_id
            self.steps[e.node_id] = StepRecord(e.node_id, "scheduled", e.attempt)
        elif e.type == EventType.STEP_STARTED:
            assert e.node_id
            self.steps[e.node_id].status = "started"
            self.steps[e.node_id].attempt = e.attempt
        elif e.type == EventType.STEP_COMPLETED:
            assert e.node_id
            rec = self.steps[e.node_id]
            rec.status = "completed"
            rec.result_ref = e.payload_ref
        elif e.type == EventType.STEP_FAILED:
            assert e.node_id
            # A node can fail before it was ever scheduled (e.g. blocked at the
            # budget/policy gate in before_step), so create the record if absent.
            rec = self.steps.get(e.node_id) or StepRecord(e.node_id, "failed", e.attempt)
            rec.status = "failed"
            rec.error = e.data.get("error")
            self.steps[e.node_id] = rec
        elif e.type == EventType.STEP_SKIPPED:
            assert e.node_id
            self.steps[e.node_id] = StepRecord(e.node_id, "skipped")
        elif e.type == EventType.RUN_CANCELLED:
            self.status = "cancelled"
            self.cancel_requested = True
        elif e.type == EventType.GATE_APPROVED:
            assert e.node_id
            self.gate_decisions[e.node_id] = "approved"
            if e.payload_ref:
                self.gate_payloads[e.node_id] = e.payload_ref
        elif e.type in (EventType.GATE_REJECTED, EventType.GATE_EXPIRED):
            assert e.node_id
            self.gate_decisions[e.node_id] = "rejected"
        elif e.type == EventType.ROUTE_DECIDED:
            if e.node_id and "chosen_branch" in e.data:
                self.routes[e.node_id] = str(e.data["chosen_branch"])

        if e.tokens is not None:
            self.total_tokens_in += e.tokens.input
            self.total_tokens_out += e.tokens.output
        self.total_cost_usd += e.cost_usd

    def frontier(self) -> list[str]:
        """Nodes runnable now: every predecessor done, node not yet completed.
        This is the entire resume algorithm — fold, then schedule frontier()."""
        done = {nid for nid, r in self.steps.items() if r.status in ("completed", "skipped")}
        preds: dict[str, list[str]] = {n.id: [] for n in self.graph.nodes}
        for e in self.graph.edges:
            preds[e.to].append(e.from_)
        ready: list[str] = []
        for n in self.graph.nodes:
            if n.id in done:
                continue
            rec = self.steps.get(n.id)
            if rec and rec.status == "started":
                ready.append(n.id)  # mid-flight at crash → retry
                continue
            if all(p in done for p in preds[n.id]):
                ready.append(n.id)
        return ready

    def _incoming(self, node_id: str) -> list[Edge]:
        return [e for e in self.graph.edges if e.to == node_id]

    def edge_taken(self, edge: "Edge") -> bool:
        """An edge is taken iff its source completed (a skipped source is not taken)
        and its guard passes. Guard dialect in Phase 1: ``None`` (unconditional) or
        ``branch:<label>`` matched against the source router's decision. Richer CEL
        guards arrive with the policy engine in Phase 4 and default to permissive."""
        src = self.steps.get(edge.from_)
        if not (src and src.status == "completed"):
            return False
        if edge.when is None:
            return True
        if edge.when.startswith("branch:"):
            return self.routes.get(edge.from_) == edge.when[len("branch:"):]
        return True

    def should_skip(self, node_id: str) -> bool:
        """A non-root node is skipped when all its predecessors are resolved but no
        incoming edge is taken (the branch it sits on was not chosen)."""
        inc = self._incoming(node_id)
        if not inc:
            return False
        return not any(self.edge_taken(e) for e in inc)
