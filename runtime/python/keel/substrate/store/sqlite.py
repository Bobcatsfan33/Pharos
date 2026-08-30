from __future__ import annotations
import aiosqlite
from typing import AsyncIterator
from ..events import Event
from ..upcast import read_event
from .base import GENESIS, DuplicateEventError, chain_hash

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    run_id     TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    event_id   TEXT NOT NULL,
    ts         TEXT NOT NULL,
    type       TEXT NOT NULL,
    node_id    TEXT,
    body       TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
-- Write-time tamper-evidence: h_i = sha256(h_{i-1} || body_i), persisted in the
-- same transaction as the event itself (audit export cross-checks this chain).
CREATE TABLE IF NOT EXISTS chain (
    run_id     TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    prev_hash  TEXT NOT NULL,
    hash       TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
);
"""


class SqliteEventStore:
    def __init__(self, path: str = "keel.db") -> None:
        self._path = path
        self._db: aiosqlite.Connection | None = None

    @property
    def conn(self) -> aiosqlite.Connection:
        assert self._db is not None, "store not opened"
        return self._db

    async def open(self) -> "SqliteEventStore":
        self._db = await aiosqlite.connect(self._path)
        # WAL + a busy timeout so a concurrent reader (the viewer) never spuriously
        # fails against the writer.
        await self._db.execute("PRAGMA journal_mode=WAL;")
        await self._db.execute("PRAGMA busy_timeout=5000;")
        await self._db.executescript(_SCHEMA)
        await self._db.commit()
        return self

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()

    async def append_batch(self, events: list[Event]) -> None:
        assert self._db is not None
        rows = [
            (e.run_id, e.seq, e.event_id, e.ts.isoformat(), e.type.value, e.node_id, e.to_json())
            for e in events
        ]
        links = []  # write-time hash chain, committed atomically with the events
        heads: dict[str, str] = {}
        for e in events:
            prev = heads.get(e.run_id)
            if prev is None:
                prev = await self._chain_head(e.run_id)
            h = chain_hash(prev, e.to_json())
            links.append((e.run_id, e.seq, prev, h))
            heads[e.run_id] = h
        try:
            await self._db.executemany(
                "INSERT INTO events(run_id, seq, event_id, ts, type, node_id, body)"
                " VALUES (?,?,?,?,?,?,?)",
                rows,
            )
            await self._db.executemany(
                "INSERT INTO chain(run_id, seq, prev_hash, hash) VALUES (?,?,?,?)",
                links,
            )
            await self._db.commit()
        except aiosqlite.IntegrityError as e:
            await self._db.rollback()
            raise DuplicateEventError(str(e)) from e

    async def _chain_head(self, run_id: str) -> str:
        async with self.conn.execute(
            "SELECT hash FROM chain WHERE run_id=? ORDER BY seq DESC LIMIT 1", (run_id,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else GENESIS

    async def read_chain(self, run_id: str) -> list[dict[str, object]]:
        """The chain links persisted at write time (see keel.services.audit)."""
        async with self.conn.execute(
            "SELECT seq, prev_hash, hash FROM chain WHERE run_id=? ORDER BY seq ASC", (run_id,)
        ) as cur:
            return [{"seq": s, "prev_hash": p, "hash": h} async for (s, p, h) in cur]

    async def read_run(self, run_id: str) -> AsyncIterator[Event]:
        assert self._db is not None
        async with self._db.execute(
            "SELECT body FROM events WHERE run_id=? ORDER BY seq ASC", (run_id,)
        ) as cur:
            async for (body,) in cur:
                yield read_event(body)  # upcast older events to the current schema

    async def list_runs(self, limit: int = 100) -> list[str]:
        assert self._db is not None
        async with self._db.execute(
            "SELECT DISTINCT run_id FROM events ORDER BY run_id DESC LIMIT ?", (limit,)
        ) as cur:
            return [r[0] async for r in cur]
