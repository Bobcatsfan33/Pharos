"""Effect ledger — side-effect-once across crash and resume (M1).

A step that crashes after a model/tool call committed its result to the log but before
the step itself completed is re-run on resume. Without a ledger, that re-issues the
call — re-billing a model, re-sending an email. The ledger folds the run's prior events
into a record of which effects already *committed* and which are *in flight* (started
but not committed), so a resumed step replays committed calls from the log instead of
re-issuing them, and an in-flight effect follows a declared recovery policy.

This module is L2: it reads only the event envelope (L1) and the blob store. The keys
are content-derived (run + node + payload) so the same logical call maps to the same
ledger entry across processes.
"""
from __future__ import annotations
import hashlib
import json
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional
from ..substrate.events import Event, EventType
from ..substrate.ports import BlobStore


class RecoveryPolicy(str, Enum):
    RETRY = "retry"    # re-issue the effect (safe only for idempotent tools)
    FAIL = "fail"      # an effect that started but never committed fails the step
    HUMAN = "human"    # park for a human decision (treated as FAIL until a gate is wired)


@dataclass(frozen=True)
class RecordedCall:
    text: str
    tokens_in: int
    tokens_out: int
    model: str
    cost_usd: float


def effect_key(node_id: str, payload: bytes) -> str:
    return hashlib.sha256(node_id.encode() + b"\x00" + payload).hexdigest()


def tool_args_key(node_id: str, args: dict[str, Any]) -> str:
    return effect_key(node_id, json.dumps(args, sort_keys=True).encode())


class EffectLedger:
    """Built from the events that existed when a run was (re)constructed. An empty
    ledger (a fresh run) replays nothing; a resume ledger replays the pre-crash
    effects."""

    def __init__(self, prior_events: list[Event], blobs: BlobStore) -> None:
        self._blobs = blobs
        self._llm_by_node: dict[str, list[RecordedCall]] = {}
        self._tool_committed: dict[str, bytes] = {}   # idem key -> response bytes
        self._tool_started: set[str] = set()          # idem keys with request, no response
        for e in prior_events:
            self._apply(e)

    def _apply(self, e: Event) -> None:
        if e.type == EventType.LLM_RESPONSE and e.node_id:
            text = self._blobs.get(e.payload_ref).decode() if e.payload_ref else ""
            tk = e.tokens
            self._llm_by_node.setdefault(e.node_id, []).append(RecordedCall(
                text=text, tokens_in=tk.input if tk else 0,
                tokens_out=tk.output if tk else 0, model=tk.model if tk else "",
                cost_usd=e.cost_usd))
        elif e.type == EventType.TOOL_REQUEST:
            key = e.data.get("idem")
            if key:
                self._tool_started.add(str(key))
        elif e.type == EventType.TOOL_RESPONSE:
            key = e.data.get("idem")
            if key and e.payload_ref:
                self._tool_committed[str(key)] = self._blobs.get(e.payload_ref)
                self._tool_started.discard(str(key))

    # --- model calls: replayed in recorded order per node ---
    def recorded_model_responses(self, node_id: str) -> list[RecordedCall]:
        return list(self._llm_by_node.get(node_id, ()))

    # --- tool calls: keyed by node + args ---
    def committed_tool(self, key: str) -> Optional[bytes]:
        return self._tool_committed.get(key)

    def tool_in_flight(self, key: str) -> bool:
        return key in self._tool_started and key not in self._tool_committed
