"""P3-6: cost math is unit-tested and price-table changes are gated — the pinned
checksum forces any edit to DEFAULT_PRICES to be intentional (bump the version +
update this pin), so prices can't drift silently."""
import hashlib
import json

from keel.services.model.pricing import (DEFAULT_PRICES, PRICE_TABLE_VERSION,
                                          PriceTable, estimate_cost)
from keel.services.model.port import ModelResponse

# Pinned in lockstep with PRICE_TABLE_VERSION. Changing prices MUST update both.
PINNED_VERSION = "2026-06-01"
PINNED_HASH = "baa3d9631a890a93dd3339566a0f4b6d172a9eb0b9b41f43fbddbf4866f24495"


def _hash() -> str:
    payload = json.dumps({k: list(v) for k, v in sorted(DEFAULT_PRICES.items())})
    return hashlib.sha256(payload.encode()).hexdigest()


def test_price_table_change_is_gated():
    assert PRICE_TABLE_VERSION == PINNED_VERSION
    assert _hash() == PINNED_HASH, (
        "DEFAULT_PRICES changed: bump PRICE_TABLE_VERSION and update PINNED_* in this "
        "test to confirm the price change is intentional.")


def test_cost_math():
    # haiku: 0.0008/1k in, 0.004/1k out
    assert abs(estimate_cost("anthropic:claude-haiku-4-5", 1000, 1000) - 0.0048) < 1e-9
    assert abs(estimate_cost("anthropic:claude-haiku-4-5", 500, 0) - 0.0004) < 1e-9


def test_price_table_cost_from_response():
    table = PriceTable()
    resp = ModelResponse(text="x", tokens_in=2000, tokens_out=1000,
                         model="openai:gpt-4o")  # 0.005/1k in, 0.015/1k out
    assert abs(table.cost(resp) - (0.01 + 0.015)) < 1e-9


def test_unknown_model_priced_zero_and_tracked():
    table = PriceTable()
    resp = ModelResponse(text="x", tokens_in=10, tokens_out=10, model="mystery:model")
    assert table.cost(resp) == 0.0
    assert "mystery:model" in table.unknown


def test_custom_fallback_rate():
    table = PriceTable(prices={}, fallback=(1.0, 2.0))
    assert abs(estimate_cost("anything", 1000, 1000, table) - 3.0) < 1e-9
