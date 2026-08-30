"""P1-6: every provider's wire errors map onto the six-value ModelError taxonomy,
and a provider swap is one config line. Uses httpx.MockTransport — no network.
"""
import httpx
import pytest

from keel.services.model.port import ModelRequest, ModelError, ModelPort
from keel.services.model.providers import build_provider, provider_of
from keel.services.model.providers.openai import OpenAIProvider
from keel.services.model.providers.anthropic import AnthropicProvider
from keel.services.model.providers.ollama import OllamaProvider


def _req(model="anthropic:claude-haiku-4-5"):
    return ModelRequest(model=model, messages=[{"role": "user", "content": "hi"}], max_tokens=64)


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# --------------------------------------------------------------------------- #
# Success parsing per provider shape
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_openai_success_parsed():
    def handler(request):
        return httpx.Response(200, json={
            "model": "gpt-4o", "choices": [
                {"message": {"content": "hello"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 3}})
    p = OpenAIProvider(api_key="k", client=_client(handler))
    resp = await p.complete(_req("openai:gpt-4o"))
    assert resp.text == "hello" and resp.tokens_in == 11 and resp.tokens_out == 3


@pytest.mark.asyncio
async def test_anthropic_success_parsed():
    def handler(request):
        return httpx.Response(200, json={
            "model": "claude-haiku-4-5",
            "content": [{"type": "text", "text": "world"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 7, "output_tokens": 2}})
    p = AnthropicProvider(api_key="k", client=_client(handler))
    resp = await p.complete(_req())
    assert resp.text == "world" and resp.tokens_in == 7 and resp.tokens_out == 2


@pytest.mark.asyncio
async def test_ollama_success_parsed():
    def handler(request):
        return httpx.Response(200, json={
            "model": "llama3", "message": {"content": "hey"},
            "prompt_eval_count": 5, "eval_count": 4, "done_reason": "stop"})
    p = OllamaProvider(client=_client(handler))
    resp = await p.complete(_req("ollama:llama3"))
    assert resp.text == "hey" and resp.tokens_out == 4


# --------------------------------------------------------------------------- #
# Error taxonomy
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("status,headers,body,expected,retry_after", [
    (429, {"retry-after": "12"}, "slow down", "rate_limit", 12.0),
    (503, {}, "service unavailable", "overloaded", None),
    (529, {}, "overloaded", "overloaded", None),
    (401, {}, "bad key", "auth", None),
    (403, {}, "forbidden", "auth", None),
    (400, {}, "maximum context length exceeded", "context_length", None),
    (500, {}, "boom", "transient", None),
    (404, {}, "no such model", "permanent", None),
])
@pytest.mark.asyncio
async def test_error_taxonomy(status, headers, body, expected, retry_after):
    def handler(request):
        return httpx.Response(status, headers=headers, text=body)
    p = OpenAIProvider(api_key="k", client=_client(handler))
    with pytest.raises(ModelError) as ei:
        await p.complete(_req("openai:gpt-4o"))
    assert ei.value.taxonomy == expected
    if retry_after is not None:
        assert ei.value.retry_after == retry_after


@pytest.mark.asyncio
async def test_transport_timeout_is_transient():
    def handler(request):
        raise httpx.ConnectTimeout("timed out")
    p = AnthropicProvider(api_key="k", client=_client(handler))
    with pytest.raises(ModelError) as ei:
        await p.complete(_req())
    assert ei.value.taxonomy == "transient"


# --------------------------------------------------------------------------- #
# Provider swap is one config line / shared taxonomy across vendors
# --------------------------------------------------------------------------- #
def test_build_provider_one_line():
    for name in ("openai", "anthropic", "ollama"):
        port = build_provider(name)
        assert isinstance(port, ModelPort)
    with pytest.raises(ValueError, match="unknown provider"):
        build_provider("nope")


def test_provider_of():
    assert provider_of("anthropic:claude-haiku-4-5") == "anthropic"
    assert provider_of("ollama:llama3") == "ollama"


@pytest.mark.asyncio
async def test_taxonomy_is_vendor_agnostic():
    # Same 429 maps to the same taxonomy regardless of which vendor produced it.
    def handler(request):
        return httpx.Response(429, text="rate limited")
    for prov, model in [(OpenAIProvider(api_key="k", client=_client(handler)), "openai:gpt-4o"),
                        (AnthropicProvider(api_key="k", client=_client(handler)), "anthropic:x"),
                        (OllamaProvider(client=_client(handler)), "ollama:llama3")]:
        with pytest.raises(ModelError) as ei:
            await prov.complete(_req(model))
        assert ei.value.taxonomy == "rate_limit"
