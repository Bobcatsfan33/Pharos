"""The schema registry maps a stable string ref (``ref:schemas/Summary``) carried
in KIR nodes to a concrete Pydantic model. KIR stays serializable (a graph is pure
data), while the runtime resolves refs to real validators for structured-output
enforcement (P1-7) and eval assertions (P4-1).
"""
from __future__ import annotations
from typing import Type
from pydantic import BaseModel

_PREFIX = "ref:schemas/"
_REGISTRY: dict[str, Type[BaseModel]] = {}


def _short(ref: str) -> str:
    return ref[len(_PREFIX):] if ref.startswith(_PREFIX) else ref


def register_schema(name_or_model: str | Type[BaseModel],
                    model: Type[BaseModel] | None = None) -> str:
    """Register a Pydantic model under a name and return its canonical ref.

    Usage:
        register_schema(Summary)                 # -> "ref:schemas/Summary"
        register_schema("Doc", DocModel)         # -> "ref:schemas/Doc"
    """
    if isinstance(name_or_model, str):
        if model is None:
            raise ValueError("register_schema(name, model): model is required")
        name, target = name_or_model, model
    else:
        target, name = name_or_model, name_or_model.__name__
    _REGISTRY[_short(name)] = target
    return f"{_PREFIX}{_short(name)}"


def resolve_schema(ref: str | None) -> Type[BaseModel] | None:
    """Resolve a ref to a model, or None if ref is None. Raises if unknown so a
    typo fails loudly at run-construction time rather than silently skipping
    validation."""
    if not ref:  # None or "" -> no schema declared
        return None
    short = _short(ref)
    try:
        return _REGISTRY[short]
    except KeyError as e:
        known = ", ".join(sorted(_REGISTRY)) or "<none>"
        raise KeyError(
            f"unknown schema ref '{ref}'. Register it with register_schema(); "
            f"known schemas: {known}"
        ) from e


def is_registered(ref: str | None) -> bool:
    if not ref:
        return False
    return _short(ref) in _REGISTRY


def clear() -> None:
    """Test helper — empties the registry."""
    _REGISTRY.clear()
