"""P1-5: tracing cannot be disabled and the bus never drops control events. With a
tiny buffer and a deliberately slow store, every emitted event still lands —
backpressure blocks the producer rather than dropping (invariant #1)."""
import asyncio
import pytest
from datetime import datetime, timezone
from keel.substrate.events import Event, EventType
from keel.substrate.tracebus import TraceBus
from keel.substrate.store.memory import MemoryEventStore


class SlowStore(MemoryEventStore):
    async def append_batch(self, events):
        await asyncio.sleep(0.001)  # simulate a slow backend
        await super().append_batch(events)


def _ev(seq):
    return Event(event_id=f"e{seq}", run_id="r", seq=seq,
                 ts=datetime.now(timezone.utc), type=EventType.STEP_STARTED, node_id="n")


@pytest.mark.asyncio
async def test_no_events_dropped_under_backpressure():
    store = SlowStore()
    bus = TraceBus(store, buffer_size=8, batch_size=4)
    await bus.start()
    n = 200
    for i in range(n):
        await bus.emit(_ev(i))  # blocks when the buffer fills; never drops
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run("r")]
    assert len(events) == n
    assert [e.seq for e in events] == list(range(n))
