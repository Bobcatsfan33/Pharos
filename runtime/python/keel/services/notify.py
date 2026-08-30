"""Outbound notifications. A ``WebhookNotifier`` is a trace-bus EventListener that
POSTs selected control events (a gate opening, a budget kill, a run failure) to an
external URL, optionally HMAC-signed. Because it observes the persisted event stream,
notifications can never describe something the log doesn't contain.
"""
from __future__ import annotations
import hashlib
import hmac
import json
from typing import Iterable, Optional
import httpx
from ..substrate.events import Event, EventType

DEFAULT_NOTIFY_ON = frozenset({
    EventType.GATE_OPENED,
    EventType.GATE_EXPIRED,
    EventType.BUDGET_EXCEEDED,
    EventType.RUN_FAILED,
})


class WebhookNotifier:
    def __init__(self, url: str, *, secret: Optional[str] = None,
                 on_types: Iterable[EventType] = DEFAULT_NOTIFY_ON,
                 client: Optional[httpx.AsyncClient] = None,
                 timeout: float = 10.0) -> None:
        self._url = url
        self._secret = secret
        self._on = frozenset(on_types)
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self.sent: list[dict[str, object]] = []  # observability / tests

    def _sign(self, body: bytes) -> str:
        assert self._secret is not None
        return hmac.new(self._secret.encode(), body, hashlib.sha256).hexdigest()

    async def __call__(self, event: Event) -> None:
        if event.type not in self._on:
            return
        payload: dict[str, object] = {
            "type": event.type.value, "run_id": event.run_id, "node_id": event.node_id,
            "seq": event.seq, "ts": event.ts.isoformat(), "data": event.data,
        }
        body = json.dumps(payload, sort_keys=True).encode()
        headers = {"Content-Type": "application/json"}
        if self._secret:
            headers["X-Keel-Signature"] = f"sha256={self._sign(body)}"
        await self._client.post(self._url, content=body, headers=headers)
        self.sent.append(payload)

    async def aclose(self) -> None:
        await self._client.aclose()
