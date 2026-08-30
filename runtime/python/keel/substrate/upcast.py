"""Event-log schema evolution (M2).

Append-only logs outlive the software that wrote them. An event carries a
``schema_version``; at *read* time a registered chain of pure transforms upcasts an
event from the version on disk to the version the running code understands. On-disk
logs are never rewritten in place — the append-only guarantee is preserved; upcasting
happens in memory.

  * ``register_upcaster(from_version, fn)`` — ``fn(dict) -> dict`` migrates an event
    dict from ``from_version`` to ``from_version + 1`` (pure; no I/O).
  * ``read_event(raw)`` — parse, upcast to ``SCHEMA_VERSION``, validate. Stores call
    this so every read yields a current-shape ``Event``.

A missing upcaster (an old event the reader can't migrate) or a future version (newer
than the reader) raises ``UnreadableEvent`` — surfaced loudly by ``keel migrate``, never
silently dropped.
"""
from __future__ import annotations
import json
from typing import Any, Callable, Optional
from .events import Event, SCHEMA_VERSION

UpcastFn = Callable[[dict[str, Any]], dict[str, Any]]


class UnreadableEvent(Exception):
    pass


class UpcasterRegistry:
    def __init__(self, current: int = SCHEMA_VERSION) -> None:
        self.current = current
        self._chain: dict[int, UpcastFn] = {}

    def register(self, from_version: int, fn: UpcastFn) -> None:
        self._chain[from_version] = fn

    def upcast(self, d: dict[str, Any]) -> dict[str, Any]:
        v = int(d.get("schema_version", 1))
        if v > self.current:
            raise UnreadableEvent(
                f"event schema v{v} is newer than this reader (v{self.current}); upgrade KEEL")
        out = dict(d)
        while v < self.current:
            fn = self._chain.get(v)
            if fn is None:
                raise UnreadableEvent(
                    f"no upcaster for schema v{v} -> v{v + 1}; register one to read this log")
            out = fn(dict(out))
            v += 1
            out["schema_version"] = v
        return out

    def read(self, raw: str | dict[str, Any]) -> Event:
        d = json.loads(raw) if isinstance(raw, str) else dict(raw)
        return Event.model_validate(self.upcast(d))

    def is_readable(self, raw: str | dict[str, Any]) -> tuple[bool, Optional[str]]:
        try:
            self.read(raw)
            return True, None
        except (UnreadableEvent, ValueError) as e:
            return False, str(e)


# The process-wide registry the stores read through.
DEFAULT = UpcasterRegistry()


def register_upcaster(from_version: int, fn: UpcastFn) -> None:
    DEFAULT.register(from_version, fn)


def read_event(raw: str | dict[str, Any]) -> Event:
    return DEFAULT.read(raw)
