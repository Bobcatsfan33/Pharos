import pytest
from datetime import datetime, timezone
from keel.substrate.events import Event, EventType
from keel.substrate.store.memory import MemoryEventStore
from keel.substrate.store.base import DuplicateEventError


def _ev(seq):
    return Event(event_id=f"e{seq}", run_id="r1", seq=seq,
                 ts=datetime.now(timezone.utc), type=EventType.RUN_STARTED)


@pytest.mark.asyncio
async def test_duplicate_seq_rejected():
    store = MemoryEventStore()
    await store.append_batch([_ev(0)])
    with pytest.raises(DuplicateEventError):
        await store.append_batch([_ev(0)])
