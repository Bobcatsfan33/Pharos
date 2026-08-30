"""Ollama provider — local/self-hosted models, no auth, OpenAI-free."""
from __future__ import annotations
from typing import Any, AsyncIterator
from ..port import ModelRequest, ModelResponse, ModelError
from .base import BaseHTTPProvider


class OllamaProvider(BaseHTTPProvider):
    provider = "ollama"

    def __init__(self, base_url: str | None = None, **kw: Any) -> None:
        super().__init__(None, base_url, default_base_url="http://localhost:11434", **kw)

    def _payload(self, req: ModelRequest, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.strip_prefix(req.model),
            "messages": req.messages,
            "stream": stream,
            "options": {"temperature": req.temperature, "num_predict": req.max_tokens},
        }
        if req.response_schema is not None:
            payload["format"] = req.response_schema
        return payload

    async def complete(self, req: ModelRequest) -> ModelResponse:
        data = await self._post(f"{self.base_url}/api/chat", {}, self._payload(req, stream=False))
        try:
            return ModelResponse(
                text=data["message"]["content"],
                tokens_in=int(data.get("prompt_eval_count", 0)),
                tokens_out=int(data.get("eval_count", 0)),
                model=data.get("model", req.model),
                finish_reason=data.get("done_reason", "stop") or "stop",
            )
        except (KeyError, TypeError) as e:
            raise ModelError("permanent", f"malformed Ollama response: {e}") from e

    async def stream(self, req: ModelRequest) -> AsyncIterator[str]:
        import json
        import httpx
        from .base import map_status_to_error, map_transport_error
        try:
            async with self._client.stream(
                "POST", f"{self.base_url}/api/chat", json=self._payload(req, stream=True),
            ) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    raise map_status_to_error(resp.status_code, body, None)
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    piece = json.loads(line).get("message", {}).get("content")
                    if piece:
                        yield piece
        except httpx.HTTPError as exc:
            raise map_transport_error(exc) from exc
