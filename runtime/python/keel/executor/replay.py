"""Replay & diff over recorded event logs.

Because every nondeterministic value (clock, ids, model/tool output) was recorded
through an L1 port, a run's log is self-describing. Phase 1 ships two log-level
operations that this enables; full *re-execution* replay with ReplayClock/ReplayIdGen
driving live downstream steps is P2-6.

  * ``verify_recorded_replay`` — proves the log replays deterministically: the fold
    is gap-free and terminal-consistent, and every event round-trips byte-identically
    through serialization (Event -> JSON -> Event).
  * ``diff_runs`` — aligns two runs step-by-step and reports genuine divergences
    (type, route, tokens, cost, payload reference).
"""
from __future__ import annotations
from typing import Iterable
from ..substrate.events import Event
from ..kir.schema import Graph
from .state import RunState


def verify_recorded_replay(graph: Graph, run_id: str,
                           events: list[Event]) -> tuple[bool, str]:
    # 1. fold must succeed and be gap-free (raises on a seq gap).
    try:
        state = RunState.fold(run_id, graph, events)
    except ValueError as exc:
        return False, f"fold failed: {exc}"
    seqs = [e.seq for e in events]
    if seqs != list(range(len(seqs))):
        return False, "seq not gap-free/monotonic"
    # 2. every event round-trips byte-identically (the serialization contract).
    for e in events:
        raw = e.to_json()
        if Event.from_json(raw).to_json() != raw:
            return False, f"event {e.seq} not byte-stable under round-trip"
    # 3. terminal consistency.
    if state.status == "completed":
        bad = [n for n, r in state.steps.items()
               if r.status not in ("completed", "skipped")]
        if bad:
            return False, f"completed run has unfinished steps: {bad}"
    return True, (f"{len(events)} events, seq gap-free, fold consistent, "
                  f"status={state.status}")


def _key(e: Event) -> tuple[str, str]:
    return (e.node_id or "-", e.type.value)


def diff_runs(a: Iterable[Event], b: Iterable[Event]) -> list[str]:
    la, lb = list(a), list(b)
    out: list[str] = []
    n = max(len(la), len(lb))
    for i in range(n):
        ea = la[i] if i < len(la) else None
        eb = lb[i] if i < len(lb) else None
        if ea is None:
            assert eb is not None
            out.append(f"#{i:>4} + only in B: {eb.type.value} {eb.node_id or ''}")
            continue
        if eb is None:
            out.append(f"#{i:>4} - only in A: {ea.type.value} {ea.node_id or ''}")
            continue
        if _key(ea) != _key(eb):
            out.append(f"#{i:>4} ~ {ea.type.value}/{ea.node_id} != "
                       f"{eb.type.value}/{eb.node_id}")
            continue
        diffs = []
        if ea.payload_ref != eb.payload_ref:
            diffs.append("payload")
        if (ea.tokens.output if ea.tokens else 0) != (eb.tokens.output if eb.tokens else 0):
            diffs.append("tokens")
        if abs(ea.cost_usd - eb.cost_usd) > 1e-9:
            diffs.append(f"cost {ea.cost_usd:.5f}->{eb.cost_usd:.5f}")
        if ea.data.get("chosen") != eb.data.get("chosen") or \
                ea.data.get("chosen_branch") != eb.data.get("chosen_branch"):
            diffs.append("route")
        if diffs:
            out.append(f"#{i:>4} ~ {ea.type.value} {ea.node_id or ''}: {', '.join(diffs)}")
    if not out:
        out.append("runs are identical at the event level")
    return out
