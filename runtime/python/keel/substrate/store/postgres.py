"""Postgres event store (keel[pg]).

Implements the same ``EventStore`` protocol as the SQLite default, so the executor
runs unchanged against either — swapping is a config line. The ``(run_id, seq)``
primary key is the durability invariant; a conflicting append (a partition loser
that briefly held a stale lease) raises ``DuplicateEventError`` exactly as the other
backends do, so it can never silently corrupt the log.
"""
from __future__ import annotations
from typing import Any, AsyncIterator, Optional
from ..events import Event
from ..upcast import read_event
from .base import DuplicateEventError

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    run_id     TEXT    NOT NULL,
    seq        BIGINT  NOT NULL,
    event_id   TEXT    NOT NULL,
    ts         TIMESTAMPTZ NOT NULL,
    type       TEXT    NOT NULL,
    node_id    TEXT,
    body       TEXT    NOT NULL,
    PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE TABLE IF NOT EXISTS runs (
    run_id     TEXT PRIMARY KEY,
    graph_id   TEXT NOT NULL,
    graph_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tenant     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS leases (
    run_id     TEXT PRIMARY KEY,
    worker_id  TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
"""


class PostgresEventStore:
    def __init__(self, dsn: str, pool: Optional[Any] = None) -> None:
        self._dsn = dsn
        self._pool = pool

    async def open(self) -> "PostgresEventStore":
        import asyncpg
        if self._pool is None:
            self._pool = await asyncpg.create_pool(self._dsn)
        async with self._pool.acquire() as con:
            await con.execute(_SCHEMA)
        return self

    @property
    def pool(self) -> Any:
        assert self._pool is not None, "store not opened"
        return self._pool

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()

    async def append_batch(self, events: list[Event]) -> None:
        import asyncpg
        rows = [(e.run_id, e.seq, e.event_id, e.ts, e.type.value, e.node_id, e.to_json())
                for e in events]
        async with self.pool.acquire() as con:
            try:
                async with con.transaction():
                    await con.executemany(
                        "INSERT INTO events(run_id, seq, event_id, ts, type, node_id, body)"
                        " VALUES ($1,$2,$3,$4,$5,$6,$7)", rows)
            except asyncpg.UniqueViolationError as e:
                # A conflicting (run_id, seq) — reject loudly, matching SQLite/memory.
                raise DuplicateEventError(str(e)) from e

    async def read_run(self, run_id: str) -> AsyncIterator[Event]:
        async with self.pool.acquire() as con:
            rows = await con.fetch(
                "SELECT body FROM events WHERE run_id=$1 ORDER BY seq ASC", run_id)
        for r in rows:
            yield read_event(r["body"])  # upcast older events to the current schema

    async def list_runs(self, limit: int = 100) -> list[str]:
        async with self.pool.acquire() as con:
            rows = await con.fetch(
                "SELECT DISTINCT run_id FROM events ORDER BY run_id DESC LIMIT $1", limit)
        return [r["run_id"] for r in rows]
