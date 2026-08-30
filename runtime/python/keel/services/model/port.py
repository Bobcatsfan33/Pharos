from __future__ import annotations
from typing import Protocol, AsyncIterator, Optional, Any, runtime_checkable
from pydantic import BaseModel


class ModelRequest(BaseModel):
    model: str
    messages: list[dict[str, str]]
    max_tokens: int
    temperature: float = 0.0
    response_schema: Optional[dict[str, Any]] = None


class ModelResponse(BaseModel):
    text: str
    tokens_in: int
    tokens_out: int
    model: str
    finish_reason: str = "stop"


class ModelError(Exception):
    """Every provider error is normalized into ONE taxonomy so the executor's retry
    logic never has to know which vendor it is talking to."""

    TAXONOMY = {"rate_limit", "overloaded", "context_length", "auth", "transient", "permanent"}

    def __init__(self, taxonomy: str, msg: str, retry_after: Optional[float] = None) -> None:
        assert taxonomy in self.TAXONOMY, taxonomy
        super().__init__(msg)
        self.taxonomy = taxonomy
        self.retry_after = retry_after


@runtime_checkable
class ModelPort(Protocol):
    async def complete(self, req: ModelRequest) -> ModelResponse: ...
    def stream(self, req: ModelRequest) -> AsyncIterator[str]: ...
    def count_tokens(self, text: str, model: str) -> int: ...
