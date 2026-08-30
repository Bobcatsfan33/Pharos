"""Shared HTTP plumbing for model providers.

Every provider maps its wire errors onto the single six-value ``ModelError``
taxonomy so the executor's retry logic never has to know which vendor it is
talking to (the whole point of the port). Providers are built on httpx (a core
dep) rather than vendor SDKs — that keeps the core install lean and makes the
error mapping explicit and testable with ``httpx.MockTransport``.
"""
from __future__ import annotations
import os
from typing import Any, Optional, AsyncIterator
import httpx
from ..port import ModelError, ModelRequest, ModelResponse

DEFAULT_TIMEOUT = 60.0


def _retry_after(headers: httpx.Headers) -> Optional[float]:
    raw = headers.get("retry-after")
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def map_status_to_error(status: int, body: str, retry_after: Optional[float]) -> ModelError:
    """Normalize an HTTP status + body into the taxonomy. Order matters: a 400 that
    mentions context length is a distinct, non-retryable signal that should trigger
    the context compiler (Phase 3), not a blind retry."""
    low = body.lower()
    if status == 429:
        return ModelError("rate_limit", body, retry_after=retry_after)
    if status in (503, 529) or "overloaded" in low:
        return ModelError("overloaded", body, retry_after=retry_after)
    if status in (401, 403):
        return ModelError("auth", body)
    if status == 400 and ("context length" in low or "maximum context" in low
                          or "too long" in low or "max_tokens" in low):
        return ModelError("context_length", body)
    if 500 <= status < 600:
        return ModelError("transient", body, retry_after=retry_after)
    if 400 <= status < 500:
        return ModelError("permanent", body)
    return ModelError("permanent", f"unexpected status {status}: {body}")


def map_transport_error(exc: httpx.HTTPError) -> ModelError:
    if isinstance(exc, (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError)):
        return ModelError("transient", f"{type(exc).__name__}: {exc}")
    return ModelError("transient", f"{type(exc).__name__}: {exc}")


def approx_tokens(text: str) -> int:
    """Heuristic token count (~4 chars/token). Providers that ship a real tokenizer
    can override; KEEL deliberately avoids a heavy tokenizer dep in core."""
    return max(1, len(text) // 4)


class BaseHTTPProvider:
    provider: str = "base"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        *,
        client: Optional[httpx.AsyncClient] = None,
        env_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        default_base_url: str = "",
    ) -> None:
        self.api_key = api_key or (os.environ.get(env_key) if env_key else None)
        self.base_url = (base_url or default_base_url).rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=timeout)

    def strip_prefix(self, model: str) -> str:
        return model.split(":", 1)[1] if ":" in model else model

    def count_tokens(self, text: str, model: str) -> int:
        return approx_tokens(text)

    async def _post(self, url: str, headers: dict[str, str],
                    payload: dict[str, Any]) -> dict[str, Any]:
        try:
            resp = await self._client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise map_transport_error(exc) from exc
        if resp.status_code >= 400:
            raise map_status_to_error(resp.status_code, resp.text, _retry_after(resp.headers))
        data: dict[str, Any] = resp.json()
        return data

    async def aclose(self) -> None:
        await self._client.aclose()

    # Subclasses implement these.
    async def complete(self, req: ModelRequest) -> ModelResponse:  # pragma: no cover
        raise NotImplementedError

    async def stream(self, req: ModelRequest) -> AsyncIterator[str]:  # pragma: no cover
        raise NotImplementedError
        yield ""  # pragma: no cover  (makes this an async generator)
