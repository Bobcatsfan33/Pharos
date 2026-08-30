"""``keel view`` — a read-only trace viewer over the event log.

FastAPI + a dependency-free single-file SPA (no build step). It reads the same
SQLite event store, run catalog, and blob store the runtime writes to, so a run is
browsable the instant it is recorded: run list -> event timeline -> per-step
prompt/response drill-down, plus a cost rollup. Everything shown is a projection
over the event log — there is no separate observability pipeline to fall out of
sync (invariant #1).
"""
from __future__ import annotations
import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse

from ..substrate.store.sqlite import SqliteEventStore
from ..substrate.catalog import SqliteRunCatalog
from ..substrate.ports import FileBlobStore, SystemClock, UlidIdGen
from ..kir.schema import Graph
from ..executor.state import RunState
from ..services.gate_service import GateService
from .spa import INDEX_HTML


def create_app(db_path: str = "keel.db", blob_dir: str = "blobs") -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = await SqliteEventStore(db_path).open()
        app.state.store = store
        app.state.catalog = await SqliteRunCatalog(conn=store.conn).open()
        app.state.blobs = FileBlobStore(blob_dir)
        yield
        await app.state.store.close()

    app = FastAPI(title="KEEL viewer", lifespan=lifespan)

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return INDEX_HTML

    @app.get("/api/runs")
    async def list_runs() -> JSONResponse:
        runs = await app.state.catalog.list_runs(500)
        return JSONResponse([{"run_id": r.run_id, "graph_id": r.graph_id,
                              "created_at": r.created_at} for r in runs])

    @app.get("/api/runs/{run_id}")
    async def get_run(run_id: str) -> JSONResponse:
        graph_json = await app.state.catalog.get_graph(run_id)
        if graph_json is None:
            raise HTTPException(404, f"unknown run {run_id}")
        graph = Graph.model_validate_json(graph_json)
        events = [e async for e in app.state.store.read_run(run_id)]
        state = RunState.fold(run_id, graph, events)
        return JSONResponse({
            "run_id": run_id,
            "graph_id": graph.graph_id,
            "status": state.status,
            "total_cost_usd": state.total_cost_usd,
            "total_tokens_in": state.total_tokens_in,
            "total_tokens_out": state.total_tokens_out,
            "steps": {k: {"status": v.status, "attempt": v.attempt}
                      for k, v in state.steps.items()},
            "events": [_event_dict(e) for e in events],
        })

    @app.get("/api/runs/{run_id}/cost")
    async def cost_rollup(run_id: str) -> JSONResponse:
        events = [e async for e in app.state.store.read_run(run_id)]
        by_node: dict[str, float] = {}
        by_model: dict[str, float] = {}
        for e in events:
            if e.cost_usd:
                by_node[e.node_id or "-"] = by_node.get(e.node_id or "-", 0.0) + e.cost_usd
                model = (e.tokens.model if e.tokens else "") or "-"
                by_model[model] = by_model.get(model, 0.0) + e.cost_usd
        top = sorted(by_node.items(), key=lambda kv: kv[1], reverse=True)
        return JSONResponse({"by_node": by_node, "by_model": by_model,
                             "most_expensive": top[0] if top else None})

    @app.post("/api/runs/{run_id}/gates/{node_id}/{decision}")
    async def decide_gate(run_id: str, node_id: str, decision: str) -> JSONResponse:
        if decision not in ("approve", "reject"):
            raise HTTPException(400, "decision must be approve|reject")
        gates = GateService(app.state.store, UlidIdGen(), SystemClock(), app.state.blobs)
        if decision == "approve":
            await gates.approve(run_id, node_id)
        else:
            await gates.reject(run_id, node_id)
        # The decision is durable; a worker (or `keel resume`) completes the run.
        return JSONResponse({"run_id": run_id, "node_id": node_id, "decision": decision,
                             "note": "recorded; resume on next worker poll or `keel resume`"})

    @app.get("/api/costs")
    async def costs() -> JSONResponse:
        from ..services.cost import cost_rollup
        roll = await cost_rollup(app.state.store, app.state.catalog)
        return JSONResponse(roll.to_dict())

    @app.get("/api/overview")
    async def overview() -> JSONResponse:
        from ..kir.schema import Graph
        infos = await app.state.catalog.list_runs(500)
        by_status: dict[str, int] = {}
        by_day: dict[str, float] = {}
        by_graph: dict[str, int] = {}
        recent: list[dict[str, Any]] = []
        total_usd = 0.0
        total_events = total_in = total_out = 0
        for info in infos:
            gj = await app.state.catalog.get_graph(info.run_id)
            if gj is None:
                continue
            graph = Graph.model_validate_json(gj)
            events = [e async for e in app.state.store.read_run(info.run_id)]
            state = RunState.fold(info.run_id, graph, events)
            by_status[state.status] = by_status.get(state.status, 0) + 1
            by_graph[info.graph_id] = by_graph.get(info.graph_id, 0) + 1
            by_day[info.created_at[:10]] = by_day.get(info.created_at[:10], 0.0) + state.total_cost_usd
            total_usd += state.total_cost_usd
            total_events += len(events)
            total_in += state.total_tokens_in
            total_out += state.total_tokens_out
            recent.append({"run_id": info.run_id, "graph_id": info.graph_id,
                           "status": state.status, "cost_usd": state.total_cost_usd,
                           "events": len(events), "created_at": info.created_at,
                           "tenant": info.tenant})
        return JSONResponse({
            "runs": len(recent), "by_status": by_status, "by_graph": by_graph,
            "by_day": by_day, "total_usd": total_usd, "total_events": total_events,
            "total_tokens_in": total_in, "total_tokens_out": total_out,
            "recent": recent[:50],
        })

    @app.get("/api/diff/{run_a}/{run_b}")
    async def diff(run_a: str, run_b: str) -> JSONResponse:
        from ..executor.replay import diff_runs
        a = [e async for e in app.state.store.read_run(run_a)]
        b = [e async for e in app.state.store.read_run(run_b)]
        return JSONResponse({"lines": diff_runs(a, b)})

    @app.get("/api/blob/{ref:path}")
    async def get_blob(ref: str) -> PlainTextResponse:
        try:
            data = app.state.blobs.get(ref if ref.startswith("blob:") else f"blob:{ref}")
        except FileNotFoundError:
            raise HTTPException(404, "blob not found")
        try:
            pretty = json.dumps(json.loads(data), indent=2)
            return PlainTextResponse(pretty)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return PlainTextResponse(data.decode("utf-8", "replace"))

    return app


def _event_dict(e: Any) -> dict[str, Any]:
    return {
        "seq": e.seq, "type": e.type.value, "node_id": e.node_id, "attempt": e.attempt,
        "ts": e.ts.isoformat(), "cost_usd": e.cost_usd, "payload_ref": e.payload_ref,
        "tokens": ({"input": e.tokens.input, "output": e.tokens.output,
                    "model": e.tokens.model} if e.tokens else None),
        "data": e.data,
    }


def serve(db_path: str = "keel.db", blob_dir: str = "blobs",
          host: str = "127.0.0.1", port: int = 8765) -> None:  # pragma: no cover
    import uvicorn
    uvicorn.run(create_app(db_path, blob_dir), host=host, port=port)
