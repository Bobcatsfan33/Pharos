"""Versioned price tables. Cost is ``(tokens_in/1000)*in_rate +
(tokens_out/1000)*out_rate`` in USD. Prices are a data table, not magic numbers
scattered through the code, so P3-6 can gate price changes in CI and the cost
math stays unit-tested. Unknown models price at 0.0 and are reported, never
silently guessed.
"""
from __future__ import annotations
from .port import ModelResponse

PRICE_TABLE_VERSION = "2026-06-01"

# model id -> (USD per 1k input tokens, USD per 1k output tokens)
DEFAULT_PRICES: dict[str, tuple[float, float]] = {
    # Anthropic
    "anthropic:claude-opus-4-8": (0.015, 0.075),
    "anthropic:claude-sonnet-4-6": (0.003, 0.015),
    "anthropic:claude-haiku-4-5": (0.0008, 0.004),
    # OpenAI
    "openai:gpt-4o": (0.005, 0.015),
    "openai:gpt-4o-mini": (0.00015, 0.0006),
    # Local / self-hosted
    "ollama:llama3": (0.0, 0.0),
    # Test doubles
    "mock:test": (0.0, 0.0),
}


class PriceTable:
    """Resolves per-model rates, falling back to a configurable default. ``unknown``
    accumulates models that were priced at the fallback so the caller can surface
    them rather than quietly under-reporting spend."""

    def __init__(self, prices: dict[str, tuple[float, float]] | None = None,
                 fallback: tuple[float, float] = (0.0, 0.0)) -> None:
        self._prices = dict(DEFAULT_PRICES if prices is None else prices)
        self._fallback = fallback
        self.unknown: set[str] = set()

    def rate(self, model: str) -> tuple[float, float]:
        if model in self._prices:
            return self._prices[model]
        self.unknown.add(model)
        return self._fallback

    def cost(self, resp: ModelResponse) -> float:
        in_rate, out_rate = self.rate(resp.model)
        return (resp.tokens_in / 1000.0) * in_rate + (resp.tokens_out / 1000.0) * out_rate


def estimate_cost(model: str, tokens_in: int, tokens_out: int,
                  table: PriceTable | None = None) -> float:
    t = table or PriceTable()
    in_rate, out_rate = t.rate(model)
    return (tokens_in / 1000.0) * in_rate + (tokens_out / 1000.0) * out_rate
