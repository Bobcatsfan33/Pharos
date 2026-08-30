"""Run scheduler — the queue workers pull run ids from.

Delivery is at-least-once; a run may be enqueued more than once (a re-enqueue after
a suspected crash, a duplicate notify). That is safe because the lease makes
processing idempotent: only one worker acquires the lease and advances the run; the
others fail to acquire and move on. The in-memory implementation backs single-process
clusters and tests; the NATS JetStream implementation (`scheduler_nats`) backs
multi-node deployments behind this same protocol.
"""
from __future__ import annotations
import asyncio
from typing import Protocol, runtime_checkable


@runtime_checkable
class Scheduler(Protocol):
    async def enqueue(self, run_id: str) -> None: ...
    async def dequeue(self) -> str: ...


class MemoryScheduler:
    def __init__(self) -> None:
        self._q: asyncio.Queue[str] = asyncio.Queue()

    async def enqueue(self, run_id: str) -> None:
        await self._q.put(run_id)

    async def dequeue(self) -> str:
        return await self._q.get()

    def qsize(self) -> int:
        return self._q.qsize()

    def empty(self) -> bool:
        return self._q.empty()
