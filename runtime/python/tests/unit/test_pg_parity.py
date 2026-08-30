"""P2-1: the Postgres store behaves identically to the in-memory/SQLite stores —
ordered read-back and (run_id, seq) duplicate rejection. Skipped unless DATABASE_URL
points at a reachable Postgres (the code is type-checked regardless)."""
import os
from datetime import datetime, timezone

import pytest

pytest.importorskip("asyncpg")
from keel.substrate.events import Event, EventType  # noqa: E402
from keel.substrate.store.base import DuplicateEventError  # noqa: E402
from keel.substrate.store.postgres import PostgresEventStore  # noqa: E402

DSN = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="set DATABASE_URL to run PG parity")


def _ev(run_id, seq):
    return Event(event_id=f"e{seq}", run_id=run_id, seq=seq,
                 ts=datetime.now(timezone.utc), type=EventType.STEP_STARTED, node_id="n")


@pytest.mark.asyncio
async def test_pg_ordered_readback_and_dup_rejection():
    store = await PostgresEventStore(DSN).open()
    rid = f"parity-{datetime.now(timezone.utc).timestamp()}"
    try:
        await store.append_batch([_ev(rid, 0), _ev(rid, 1), _ev(rid, 2)])
        got = [e.seq async for e in store.read_run(rid)]
        assert got == [0, 1, 2]
        with pytest.raises(DuplicateEventError):
            await store.append_batch([_ev(rid, 1)])  # conflicting (run_id, seq)
    finally:
        await store.close()
