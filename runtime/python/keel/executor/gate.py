from __future__ import annotations
from typing import Any
from ..substrate.events import EventType
from .engine import RunContext, FatalError, GatePaused
from ..kir.schema import Node

__all__ = ["human_gate_handler", "GatePaused"]


async def human_gate_handler(ctx: RunContext, node: Node, inputs: dict[str, bytes]) -> bytes:
    """Parks the run with zero compute until a GATE_* event is appended to the log
    by an external approver. On resume the decision is read back from folded state,
    so 'parked' and 'crashed' are indistinguishable to a fresh worker — both fold
    the log, see the gate node on the frontier, and either pause again or complete.
    """
    decision = ctx.state.gate_decisions.get(node.id)
    if decision is None:
        await ctx.emit(
            EventType.GATE_OPENED,
            node_id=node.id,
            data={
                "prompt": node.config.get("prompt", ""),
                "ttl_s": node.config.get("ttl_s"),
                "context": _summarize(inputs),
            },
        )
        await ctx.emit(EventType.RUN_PAUSED)
        ctx.state.status = "paused"
        raise GatePaused(node.id)

    if decision == "rejected":
        raise FatalError(f"human rejected gate {node.id}")

    # Approved (optionally with an edited payload that becomes this step's output).
    ref = ctx.state.gate_payloads.get(node.id)
    if ref is not None:
        return ctx.blobs.get(ref)
    fallback: Any = node.config.get("approved_payload", b"approved")
    return fallback if isinstance(fallback, bytes) else str(fallback).encode()


def _summarize(inputs: dict[str, bytes]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in inputs.items():
        text = v.decode("utf-8", errors="replace")
        out[k] = text if len(text) <= 280 else text[:277] + "..."
    return out
