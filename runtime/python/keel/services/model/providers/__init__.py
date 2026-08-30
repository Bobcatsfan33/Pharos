"""Provider registry. Selecting a provider is one config line:

    port = build_provider("anthropic")          # reads ANTHROPIC_API_KEY
    port = build_provider("ollama")              # local, no key

The model id carries the provider as a prefix (``anthropic:claude-haiku-4-5``),
so the router maps a model to its provider with ``provider_of()``.
"""
from __future__ import annotations
from typing import Any, Callable
from ..port import ModelPort
from .base import BaseHTTPProvider
from .openai import OpenAIProvider
from .anthropic import AnthropicProvider
from .ollama import OllamaProvider

_BUILDERS: dict[str, Callable[..., ModelPort]] = {
    "openai": OpenAIProvider,
    "anthropic": AnthropicProvider,
    "ollama": OllamaProvider,
}


def build_provider(name: str, **kwargs: Any) -> ModelPort:
    try:
        return _BUILDERS[name](**kwargs)
    except KeyError as e:
        known = ", ".join(sorted(_BUILDERS))
        raise ValueError(f"unknown provider '{name}'; known: {known}") from e


def provider_of(model: str) -> str:
    return model.split(":", 1)[0]


__all__ = [
    "BaseHTTPProvider", "OpenAIProvider", "AnthropicProvider", "OllamaProvider",
    "build_provider", "provider_of",
]
