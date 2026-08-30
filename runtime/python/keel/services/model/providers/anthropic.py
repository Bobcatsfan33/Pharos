"""Anthropic Messages API provider."""
from __future__ import annotations
from typing import Any, AsyncIterator
from ..port import ModelRequest, ModelResponse, ModelError
from .base import BaseHTTPProvider

ANTHROPIC_VERSION = "2023-06-01"


class AnthropicProvider(BaseHTTPProvider):
    provider = "anthropic"

    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 **kw: Any) -> None:
        super().__init__(api_key, base_url, env_key="ANTHROPIC_API_KEY",
                         default_base_url="https://api.anthropic.com", **kw)

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self.api_key or "",
            "anthropic-version": ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }

    def _payload(self, req: ModelRequest, stream: bool) -> dict[str, Any]:
        # Anthropic separates the system prompt from the message turns.
        system_parts = [m["content"] for m in req.messages if m["role"] == "system"]
        turns = [m for m in req.messages if m["role"] != "system"]
        payload: dict[str, Any] = {
            "model": self.strip_prefix(req.model),
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "messages": turns,
            "stream": stream,
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)
        return payload

    async def complete(self, req: ModelRequest) -> ModelResponse:
        data = await self._post(f"{self.base_url}/v1/messages",
                                self._headers(), self._payload(req, stream=False))
        try:
            blocks = data.get("content", [])
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
            usage = data.get("usage", {})
            return ModelResponse(
                text=text,
                tokens_in=int(usage.get("input_tokens", 0)),
                tokens_out=int(usage.get("output_tokens", 0)),
                model=data.get("model", req.model),
                finish_reason=data.get("stop_reason", "stop") or "stop",
            )
        except (KeyError, IndexError, TypeError) as e:
            raise ModelError("permanent", f"malformed Anthropic response: {e}") from e

    async def stream(self, req: ModelRequest) -> AsyncIterator[str]:
        import json
        import httpx
        from .base import map_status_to_error, map_transport_error, _retry_after
        try:
            async with self._client.stream(
                "POST", f"{self.base_url}/v1/messages",
                headers=self._headers(), json=self._payload(req, stream=True),
            ) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    raise map_status_to_error(resp.status_code, body, _retry_after(resp.headers))
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    evt = json.loads(line[len("data: "):])
                    if evt.get("type") == "content_block_delta":
                        piece = evt.get("delta", {}).get("text")
                        if piece:
                            yield piece
        except httpx.HTTPError as exc:
            raise map_transport_error(exc) from exc
