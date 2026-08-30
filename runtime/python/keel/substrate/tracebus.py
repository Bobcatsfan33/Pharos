from __future__ import annotations
import asyncio
from typing import Optional, Protocol, Callable, Awaitable
from .events import Event
from .store.base import EventStore
from .redact import Redactor


class OTelExporter(Protocol):
    def export(self, event: Event) -> None: ...


# Async, post-persist listeners (webhooks, notifiers). They observe redacted,
# persisted events and must not raise — a failing listener is isolated, never
# allowed to wedge the trace bus.
EventListener = Callable[[Event], Awaitable[None]]


class TraceBus:
    """In-proc ring buffer + async drainer. Emitting is non-blocking; the drainer
    batches writes. Tracing cannot be disabled, only redirected. Backpressure is
    bounded: if the store wedges we block the producer rather than drop control
    events (invariant #1)."""

    def __init__(
        self,
        store: EventStore,
        redactor: Optional[Redactor] = None,
        otel_exporter: Optional[OTelExporter] = None,
        buffer_size: int = 4096,
        batch_size: int = 64,
        listeners: Optional[list[EventListener]] = None,
    ) -> None:
        self._store = store
        self.store = store  # public read-only handle (sub-runs reuse the same backend)
        self._redactor = redactor or Redactor()
        self._otel = otel_exporter
        self._listeners = listeners or []
        self._q: asyncio.Queue[Event] = asyncio.Queue(maxsize=buffer_size)
        self._batch_size = batch_size
        self._task: Optional[asyncio.Task[None]] = None
        self._closing = False

    async def start(self) -> None:
        self._task = asyncio.create_task(self._drain_loop(), name="tracebus-drain")

    async def emit(self, event: Event) -> None:
        event = self._redactor.scrub(event)
        await self._q.put(event)

    async def _drain_loop(self) -> None:
        batch: list[Event] = []
        while not (self._closing and self._q.empty()):
            try:
                ev = await asyncio.wait_for(self._q.get(), timeout=0.05)
                batch.append(ev)
            except asyncio.TimeoutError:
                pass
            if batch and (len(batch) >= self._batch_size or self._q.empty()):
                await self._store.append_batch(batch)
                if self._otel is not None:
                    for e in batch:
                        self._otel.export(e)
                for e in batch:
                    for listener in self._listeners:
                        try:
                            await listener(e)
                        except Exception:  # noqa: BLE001 — a listener never wedges the bus
                            pass
                for _ in batch:
                    self._q.task_done()
                batch.clear()

    async def flush(self) -> None:
        # Event-driven: returns as soon as every queued event has been persisted
        # (the drainer calls task_done per event), not on a polling interval.
        await self._q.join()

    async def close(self) -> None:
        self._closing = True
        if self._task is not None:
            # Drain everything still queued, then stop the loop immediately instead
            # of letting it idle in its wait_for timeout (which would add tail
            # latency to every short-lived run).
            await self._q.join()
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
