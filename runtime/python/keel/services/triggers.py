"""Event triggers (P4-4): start runs from external events instead of polling.

``POST /v1/triggers/<graph>`` with an HMAC-signed body starts a run of a registered
graph; a NATS-subject listener does the same off a message bus. HMAC verification is
constant-time and the secret never appears in a trace. The request body is stored as
a ``trigger`` input blob so the run can read what fired it.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any

from ..kir.schema import Graph
from .runner import RunIdConflictError, Runner

try:  # FastAPI is the [viewer] extra; triggers needs it only for the HTTP app.
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse
except ImportError:  # pragma: no cover
    FastAPI = Request = HTTPException = JSONResponse = None  # type: ignore[assignment,misc]


def verify_hmac(secret: str, body: bytes, signature: str | None) -> bool:
    if not signature:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


class TriggerService:
    def __init__(self, runner: Runner, graphs: dict[str, Graph], secret: str) -> None:
        self._runner = runner
        self._graphs = graphs
        self._secret = secret

    def has(self, graph_name: str) -> bool:
        return graph_name in self._graphs

    def _run_id(self, graph_name: str, idempotency_key: str) -> str:
        message = f"keel-trigger-v1\0{graph_name}\0{idempotency_key}".encode()
        digest = hmac.new(self._secret.encode(), message, hashlib.sha256).hexdigest()
        return f"trigger-{digest[:40]}"

    async def fire(
        self, graph_name: str, body: bytes, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        graph = self._graphs[graph_name]
        # Stash the trigger payload so the run can reference what fired it.
        self._runner.blobs.put(body)
        if idempotency_key is None:
            state = await self._runner.run(graph)
            return {"run_id": state.run_id, "status": state.status, "replayed": False}
        run_id = self._run_id(graph_name, idempotency_key)
        fingerprint = hashlib.sha256(body).hexdigest()
        state, replayed = await self._runner.run_once(
            graph, run_id=run_id, claim_graph_id=f"{graph.graph_id}#trigger-sha256:{fingerprint}"
        )
        return {"run_id": state.run_id, "status": state.status, "replayed": replayed}


def create_trigger_app(service: TriggerService) -> Any:
    # Imported at module scope (below) so FastAPI can resolve the stringized
    # annotations under `from __future__ import annotations`.
    app = FastAPI(title="KEEL triggers")

    @app.post("/v1/triggers/{graph_name}")
    async def trigger(graph_name: str, request: Request) -> JSONResponse:
        body = await request.body()
        if not verify_hmac(service._secret, body, request.headers.get("X-Keel-Signature")):
            raise HTTPException(401, "invalid or missing HMAC signature")
        if not service.has(graph_name):
            raise HTTPException(404, f"no graph '{graph_name}' registered")
        idempotency_key = request.headers.get("Idempotency-Key")
        if idempotency_key is not None and (
            not 1 <= len(idempotency_key) <= 255
            or not idempotency_key.isascii()
            or any(ord(char) < 0x21 or ord(char) > 0x7E for char in idempotency_key)
        ):
            raise HTTPException(400, "Idempotency-Key must be 1..255 visible ASCII characters")
        try:
            result = await service.fire(graph_name, body, idempotency_key)
        except RunIdConflictError as exc:
            raise HTTPException(
                409, "Idempotency-Key was already used with a different body"
            ) from exc
        return JSONResponse(result)

    return app


class NatsTriggerListener:
    """Starts a run for each message on a subject (subject tail = graph name).
    Requires keel[nats]."""

    def __init__(
        self,
        service: TriggerService,
        url: str = "nats://localhost:4222",
        subject: str = "keel.triggers.>",
    ) -> None:
        self._service = service
        self._url = url
        self._subject = subject
        self._nc: Any | None = None

    async def serve(self) -> None:  # pragma: no cover - needs a live broker
        import nats

        self._nc = await nats.connect(self._url)

        async def handle(msg: Any) -> None:
            graph_name = msg.subject.rsplit(".", 1)[-1]
            if self._service.has(graph_name):
                await self._service.fire(graph_name, msg.data)

        await self._nc.subscribe(self._subject, cb=handle)
