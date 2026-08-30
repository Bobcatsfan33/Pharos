from __future__ import annotations
import hashlib
from typing import Protocol, AsyncIterator, runtime_checkable
from ..events import Event

# Hash-chain primitive shared by write-time chaining (sqlite store) and the audit
# projection (keel.services.audit) — both MUST produce identical chains.
GENESIS = "0" * 64


def chain_hash(prev: str, body: str) -> str:
    return hashlib.sha256((prev + "\n" + body).encode()).hexdigest()


class DuplicateEventError(Exception):
    """Raised when an (run_id, seq) collision is detected — a replayed/duplicate
    write. The executor treats this as 'already persisted' and continues."""


@runtime_checkable
class EventStore(Protocol):
    async def append_batch(self, events: list[Event]) -> None: ...
    def read_run(self, run_id: str) -> AsyncIterator[Event]: ...
    async def list_runs(self, limit: int = 100) -> list[str]: ...
