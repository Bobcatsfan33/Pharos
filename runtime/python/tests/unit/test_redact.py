"""P1-5: the redactor scrubs secrets in event data BEFORE persistence, and it runs
on the trace bus so secrets never reach the store."""
import pytest
from datetime import datetime, timezone
from keel.substrate.events import Event, EventType
from keel.substrate.redact import Redactor
from keel.substrate.tracebus import TraceBus
from keel.substrate.store.memory import MemoryEventStore


def _ev(seq, data):
    return Event(event_id=f"e{seq}", run_id="r", seq=seq, ts=datetime.now(timezone.utc),
                 type=EventType.LLM_REQUEST, data=data)


def test_scrubs_api_key_email_bearer():
    r = Redactor()
    e = _ev(0, {"prompt": "key sk-abcdefghijklmnopqrstuvwx and a@b.com",
                "auth": "Bearer abc.def-123"})
    out = r.scrub(e)
    blob = str(out.data)
    assert "sk-abcdefghijklmnopqrstuvwx" not in blob
    assert "a@b.com" not in blob
    assert "Bearer abc.def-123" not in blob
    assert "[REDACTED]" in blob


def test_scrub_is_recursive_and_immutable():
    r = Redactor()
    e = _ev(0, {"nested": {"list": ["email me at x@y.org"]}})
    out = r.scrub(e)
    assert "x@y.org" not in str(out.data)
    assert "x@y.org" in str(e.data)  # original untouched (immutability)


@pytest.mark.asyncio
async def test_bus_scrubs_before_persist():
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    await bus.emit(_ev(0, {"prompt": "token sk-zzzzzzzzzzzzzzzzzzzzzz"}))
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run("r")]
    assert "sk-zzzzzzzzzzzzzzzzzzzzzz" not in str(events[0].data)
