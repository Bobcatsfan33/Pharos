from __future__ import annotations
import re
from typing import Any, Pattern
from .events import Event

_DEFAULT_PATTERNS: list[Pattern[str]] = [
    re.compile(r"(?i)\b(sk-[a-z0-9]{20,})\b"),
    re.compile(r"(?i)\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    re.compile(r"(?i)bearer\s+[a-z0-9._\-]+"),
]


class Redactor:
    """Runs on the trace bus BEFORE persistence so secrets never touch disk."""

    def __init__(self, patterns: list[Pattern[str]] | None = None) -> None:
        self._patterns = patterns or _DEFAULT_PATTERNS

    def _scrub_str(self, s: str) -> str:
        for p in self._patterns:
            s = p.sub("[REDACTED]", s)
        return s

    def _scrub_obj(self, o: Any) -> Any:
        if isinstance(o, str):
            return self._scrub_str(o)
        if isinstance(o, dict):
            return {k: self._scrub_obj(v) for k, v in o.items()}
        if isinstance(o, list):
            return [self._scrub_obj(v) for v in o]
        return o

    def scrub(self, event: Event) -> Event:
        if not event.data:
            return event
        return event.model_copy(update={"data": self._scrub_obj(event.data)})
