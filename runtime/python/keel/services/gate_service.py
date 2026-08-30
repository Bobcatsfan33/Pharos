"""GateService — the external approval path for human gates.

Deciding a gate is just appending a GATE_* event to the log and (optionally)
re-enqueuing the run for any worker. It deliberately needs neither the original
worker, process, nor machine: a fresh worker folds the log, sees the gate decision,
and completes the step. Because seq is gap-free, the next seq is simply the event
count — no graph or full fold required to append a decision.
"""
from __future__ import annotations
from typing import Optional
from ..substrate.events import Event, EventType
from ..substrate.ports import Clock, IdGen, BlobStore
from ..substrate.store.base import EventStore
from .scheduler import Scheduler


class GateService:
    def __init__(self, store: EventStore, ids: IdGen, clock: Clock, blobs: BlobStore,
                 scheduler: Optional[Scheduler] = None) -> None:
        self._store = store
        self._ids = ids
        self._clock = clock
        self._blobs = blobs
        self._scheduler = scheduler

    async def approve(self, run_id: str, node_id: str,
                      edited_payload: Optional[bytes] = None) -> None:
        await self._decide(run_id, node_id, EventType.GATE_APPROVED, edited_payload)

    async def reject(self, run_id: str, node_id: str) -> None:
        await self._decide(run_id, node_id, EventType.GATE_REJECTED, None)

    async def expire(self, run_id: str, node_id: str) -> None:
        await self._decide(run_id, node_id, EventType.GATE_EXPIRED, None)

    async def _decide(self, run_id: str, node_id: str, etype: EventType,
                      payload: Optional[bytes]) -> None:
        seq = len([e async for e in self._store.read_run(run_id)])  # gap-free => count
        ref = self._blobs.put(payload) if payload is not None else None
        ev = Event(event_id=self._ids.new(), run_id=run_id, seq=seq,
                   ts=self._clock.now(), type=etype, node_id=node_id, payload_ref=ref)
        await self._store.append_batch([ev])
        if self._scheduler is not None:
            await self._scheduler.enqueue(run_id)  # wake any worker to resume
