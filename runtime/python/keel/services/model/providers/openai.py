"""OpenAI (and OpenAI-compatible) chat-completions provider."""
from __future__ import annotations
from typing import Any, AsyncIterator
from ..port import ModelRequest, ModelResponse, ModelError
from .base import BaseHTTPProvider


class OpenAIProvider(BaseHTTPProvider):
    provider = "openai"

    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 **kw: Any) -> None:
        super().__init__(api_key, base_url, env_key="OPENAI_API_KEY",
                         default_base_url="https://api.openai.com/v1", **kw)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _payload(self, req: ModelRequest, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.strip_prefix(req.model),
            "messages": req.messages,
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "stream": stream,
        }
        if req.response_schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "output", "schema": req.response_schema, "strict": True},
            }
        return payload

    async def complete(self, req: ModelRequest) -> ModelResponse:
        data = await self._post(f"{self.base_url}/chat/completions",
                                self._headers(), self._payload(req, stream=False))
        try:
            choice = data["choices"][0]
            usage = data.get("usage", {})
            return ModelResponse(
                text=choice["message"]["content"] or "",
                tokens_in=int(usage.get("prompt_tokens", 0)),
                tokens_out=int(usage.get("completion_tokens", 0)),
                model=data.get("model", req.model),
                finish_reason=choice.get("finish_reason", "stop"),
            )
        except (KeyError, IndexError, TypeError) as e:
            raise ModelError("permanent", f"malformed OpenAI response: {e}") from e

    async def stream(self, req: ModelRequest) -> AsyncIterator[str]:
        import json
        try:
            async with self._client.stream(
                "POST", f"{self.base_url}/chat/completions",
                headers=self._headers(), json=self._payload(req, stream=True),
            ) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    from .base import map_status_to_error, _retry_after
                    raise map_status_to_error(resp.status_code, body, _retry_after(resp.headers))
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    chunk = line[len("data: "):]
                    if chunk.strip() == "[DONE]":
                        break
                    delta = json.loads(chunk)["choices"][0].get("delta", {}).get("content")
                    if delta:
                        yield delta
        except Exception as exc:
            if isinstance(exc, ModelError):
                raise
            from .base import map_transport_error
            import httpx
            if isinstance(exc, httpx.HTTPError):
                raise map_transport_error(exc) from exc
            raise
