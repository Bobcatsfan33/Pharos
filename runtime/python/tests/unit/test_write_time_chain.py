"""The sqlite store persists the hash chain at WRITE time (same transaction as
the events), so tampering with a stored body after the fact is detectable by
comparing the stored chain to a recompute — no export step required."""
import pytest
from datetime import datetime, timezone

from keel.substrate.events import Event, EventType
from keel.substrate.store.sqlite import SqliteEventStore
from keel.services.audit import compute_chain


def _ev(seq):
    return Event(event_id=f"e{seq}", run_id="r1", seq=seq,
                 ts=datetime.now(timezone.utc), type=EventType.RUN_STARTED)


@pytest.mark.asyncio
async def test_stored_chain_matches_audit_projection(tmp_path):
    store = await SqliteEventStore(str(tmp_path / "keel.db")).open()
    events = [_ev(0), _ev(1), _ev(2)]
    await store.append_batch(events[:2])
    await store.append_batch(events[2:])  # chain continues across batches

    stored = await store.read_chain("r1")
    assert stored == compute_chain(events)
    await store.close()


@pytest.mark.asyncio
async def test_post_hoc_body_tamper_breaks_stored_chain(tmp_path):
    store = await SqliteEventStore(str(tmp_path / "keel.db")).open()
    await store.append_batch([_ev(0), _ev(1)])

    # An attacker edits a stored body *after* the write.
    await store.conn.execute(
        "UPDATE events SET body = replace(body, '\"attempt\":1', '\"attempt\":9')"
        " WHERE run_id='r1' AND seq=0")
    await store.conn.commit()

    tampered = [e async for e in store.read_run("r1")]
    assert compute_chain(tampered) != await store.read_chain("r1")
    await store.close()
