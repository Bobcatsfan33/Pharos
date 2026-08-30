"""Run catalog — the small amount of run metadata that is not itself an event.

The event log is the source of truth for *what happened* in a run, but resume,
replay, and the viewer also need the KIR graph the run executed (the graph is not
an event). The catalog stores that graph JSON plus a denormalized run summary. It
is deliberately separate from the EventStore so the event contract stays minimal.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import aiosqlite


@dataclass(frozen=True)
class RunInfo:
    run_id: str
    graph_id: str
    created_at: str
    tenant: str = ""


@runtime_checkable
class RunCatalog(Protocol):
    async def claim_run(
        self, run_id: str, graph_id: str, graph_json: str, created_at: str, tenant: str = ""
    ) -> bool: ...
    async def record_run(
        self, run_id: str, graph_id: str, graph_json: str, created_at: str, tenant: str = ""
    ) -> None: ...
    async def get_graph(self, run_id: str) -> str | None: ...
    async def get_run(self, run_id: str) -> RunInfo | None: ...
    async def list_runs(self, limit: int = 100) -> list[RunInfo]: ...


_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id     TEXT PRIMARY KEY,
    graph_id   TEXT NOT NULL,
    graph_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tenant     TEXT NOT NULL DEFAULT ''
);
"""


class SqliteRunCatalog:
    """Stores run metadata. To avoid two writer connections deadlocking on the same
    SQLite file, it reuses the EventStore's connection when one is passed; otherwise
    it owns its own."""

    def __init__(self, path: str = "keel.db", *, conn: aiosqlite.Connection | None = None) -> None:
        self._path = path
        self._db: aiosqlite.Connection | None = conn
        self._owns = conn is None

    async def open(self) -> SqliteRunCatalog:
        if self._db is None:
            self._db = await aiosqlite.connect(self._path)
            await self._db.execute("PRAGMA busy_timeout=5000;")
        await self._db.executescript(_SCHEMA)
        await self._db.commit()
        return self

    async def close(self) -> None:
        if self._db is not None and self._owns:
            await self._db.close()

    async def record_run(
        self, run_id: str, graph_id: str, graph_json: str, created_at: str, tenant: str = ""
    ) -> None:
        await self.claim_run(run_id, graph_id, graph_json, created_at, tenant)

    async def claim_run(
        self, run_id: str, graph_id: str, graph_json: str, created_at: str, tenant: str = ""
    ) -> bool:
        assert self._db is not None
        cursor = await self._db.execute(
            "INSERT INTO runs(run_id, graph_id, graph_json, created_at, tenant)"
            " VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING",
            (run_id, graph_id, graph_json, created_at, tenant),
        )
        await self._db.commit()
        return cursor.rowcount == 1

    async def get_graph(self, run_id: str) -> str | None:
        assert self._db is not None
        async with self._db.execute("SELECT graph_json FROM runs WHERE run_id=?", (run_id,)) as cur:
            row = await cur.fetchone()
            return row[0] if row else None

    async def get_run(self, run_id: str) -> RunInfo | None:
        assert self._db is not None
        async with self._db.execute(
            "SELECT run_id, graph_id, created_at, tenant FROM runs WHERE run_id=?", (run_id,)
        ) as cur:
            row = await cur.fetchone()
            return RunInfo(row[0], row[1], row[2], row[3]) if row else None

    async def list_runs(self, limit: int = 100) -> list[RunInfo]:
        assert self._db is not None
        async with self._db.execute(
            "SELECT run_id, graph_id, created_at, tenant FROM runs"
            " ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            return [RunInfo(r[0], r[1], r[2], r[3]) async for r in cur]


class MemoryRunCatalog:
    def __init__(self) -> None:
        self._runs: dict[str, tuple[str, str, str, str]] = {}

    async def record_run(
        self, run_id: str, graph_id: str, graph_json: str, created_at: str, tenant: str = ""
    ) -> None:
        await self.claim_run(run_id, graph_id, graph_json, created_at, tenant)

    async def claim_run(
        self, run_id: str, graph_id: str, graph_json: str, created_at: str, tenant: str = ""
    ) -> bool:
        if run_id in self._runs:
            return False
        self._runs[run_id] = (graph_id, graph_json, created_at, tenant)
        return True

    async def get_graph(self, run_id: str) -> str | None:
        return self._runs[run_id][1] if run_id in self._runs else None

    async def get_run(self, run_id: str) -> RunInfo | None:
        value = self._runs.get(run_id)
        return RunInfo(run_id, value[0], value[2], value[3]) if value else None

    async def list_runs(self, limit: int = 100) -> list[RunInfo]:
        items = sorted(self._runs.items(), key=lambda kv: kv[1][2], reverse=True)
        return [RunInfo(rid, g, c, t) for rid, (g, _j, c, t) in items[:limit]]
