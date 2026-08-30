from __future__ import annotations
from typing import AsyncIterator
from ..events import Event
from .base import DuplicateEventError


class MemoryEventStore:
    """In-process event store for tests. Enforces the same (run_id, seq) uniqueness
    invariant as the durable backends."""

    def __init__(self) -> None:
        self._runs: dict[str, dict[int, Event]] = {}

    async def append_batch(self, events: list[Event]) -> None:
        for e in events:
            bucket = self._runs.setdefault(e.run_id, {})
            if e.seq in bucket:
                raise DuplicateEventError(f"{e.run_id}/{e.seq}")
            bucket[e.seq] = e

    async def read_run(self, run_id: str) -> AsyncIterator[Event]:
        for seq in sorted(self._runs.get(run_id, {})):
            yield self._runs[run_id][seq]

    async def list_runs(self, limit: int = 100) -> list[str]:
        return list(self._runs)[:limit]
