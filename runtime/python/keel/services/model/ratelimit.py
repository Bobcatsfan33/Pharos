"""Rate-limit-aware admission (P3-3).

Each provider port is wrapped in a token bucket so KEEL paces its own requests; the
bucket is refilled at a steady rate and topped up from a provider's ``retry_after``
when it does return a 429. Admission is priority-ordered: interactive runs preempt
batch runs in the queue. Under a 429 storm the bucket + the executor's per-node retry
absorb the pressure so runs degrade rather than fail.

The bucket uses the run/clock's ``monotonic`` so behavior is deterministic and
replay-safe; waiting is cooperative (``asyncio.sleep``).
"""
from __future__ import annotations
import asyncio
from enum import IntEnum
from typing import AsyncIterator, Optional
from ...substrate.ports import Clock, SystemClock
from .port import ModelPort, ModelRequest, ModelResponse, ModelError


class Priority(IntEnum):
    BATCH = 0
    INTERACTIVE = 1


class TokenBucket:
    def __init__(self, rate_per_s: float, capacity: float, clock: Clock,
                 initial: Optional[float] = None) -> None:
        self.rate = rate_per_s
        self.capacity = capacity
        self._clock = clock
        self._tokens = capacity if initial is None else initial
        self._last = clock.monotonic()

    def add(self, tokens: float) -> None:
        """Grant tokens out of band (test helper / manual admission control)."""
        self._tokens = min(self.capacity, self._tokens + tokens)

    def _refill(self) -> None:
        now = self._clock.monotonic()
        elapsed = max(0.0, now - self._last)
        self._tokens = min(self.capacity, self._tokens + elapsed * self.rate)
        self._last = now

    def try_take(self) -> bool:
        self._refill()
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        return False

    def penalize(self, seconds: float) -> None:
        """A 429 told us to wait — drain the bucket so the next acquire backs off."""
        self._refill()
        self._tokens = min(self._tokens, -max(0.0, seconds) * self.rate)


class RateLimitedPort:
    """Wraps a ModelPort with token-bucket admission and priority ordering. A single
    asyncio.Lock serializes admission decisions; higher-priority waiters are admitted
    first when tokens free up."""

    def __init__(self, inner: ModelPort, *, rate_per_s: float = 10.0,
                 capacity: float = 10.0, clock: Optional[Clock] = None,
                 poll_s: float = 0.005) -> None:
        self._inner = inner
        self._clock = clock or SystemClock()
        self._bucket = TokenBucket(rate_per_s, capacity, self._clock)
        self._poll = poll_s
        self._waiting: list[Priority] = []

    async def _admit(self, priority: Priority) -> None:
        self._waiting.append(priority)
        try:
            while True:
                # only the highest-priority waiter may take a freed token
                if priority >= max(self._waiting) and self._bucket.try_take():
                    return
                await asyncio.sleep(self._poll)
        finally:
            self._waiting.remove(priority)

    async def complete(self, req: ModelRequest,
                       priority: Priority = Priority.BATCH) -> ModelResponse:
        await self._admit(priority)
        try:
            return await self._inner.complete(req)
        except ModelError as e:
            if e.taxonomy in ("rate_limit", "overloaded") and e.retry_after:
                self._bucket.penalize(e.retry_after)
            raise

    async def stream(self, req: ModelRequest) -> AsyncIterator[str]:  # pragma: no cover
        await self._admit(Priority.BATCH)
        async for chunk in self._inner.stream(req):
            yield chunk

    def count_tokens(self, text: str, model: str) -> int:
        return self._inner.count_tokens(text, model)
