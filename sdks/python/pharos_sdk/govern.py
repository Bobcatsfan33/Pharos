"""Shared tool governor for Python framework adapters (CrewAI, MS Agent Framework).

Mirrors the TypeScript @getpharos/middleware contract exactly so both stacks pass one
conformance suite:
    allow / modify  -> run the tool
    block / reject  -> raise PharosBlockedError
    escalate        -> await a human verdict, then resume exactly once
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional, Protocol

from .client import PharosBlockedError


class Governor(Protocol):
    def submit(self, **kwargs: Any) -> dict: ...
    def await_resolution(self, tenant_id: str, escalation_id: str, **kwargs: Any) -> dict: ...
    def claim(self, tenant_id: str, escalation_id: str) -> dict: ...


def _build_input(opts: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
    mapped = opts.get("map_action", lambda a: {})(args) or {}
    action = mapped.get("action", {})
    return {
        "tenantId": opts["tenant_id"],
        "action": {
            "type": action.get("type", f"tool.{opts['tool_name']}"),
            "agentId": action.get("agentId", opts["agent_id"]),
            "payload": action.get("payload", args),
        },
        "liability": mapped.get(
            "liability",
            {"mandate": None, "oversightMode": "autonomous", "blastRadius": {"financialAmount": 0, "currency": "USD", "reversibility": "reversible"}, "modelMetadata": None},
        ),
        "mandateId": mapped.get("mandate_id"),
    }


def govern_tool(governor: Governor, opts: Dict[str, Any], tool: Callable[[Dict[str, Any]], Any]) -> Callable[[Dict[str, Any]], Any]:
    """Wrap a tool callable so each invocation is governed by Pharos (exactly-once on resume)."""

    def wrapped(args: Dict[str, Any]) -> Any:
        submitted = governor.submit(**_build_input(opts, args))
        decision = submitted["verdict"]["decision"]
        if decision in ("allow", "modify"):
            return tool(args)
        if decision == "block":
            raise PharosBlockedError("tier-policy block", submitted["verdict"]["ruleCitations"])
        # escalate
        escalation = submitted.get("escalation")
        if not escalation:
            raise PharosBlockedError("escalated without a continuation handle")
        resolved = governor.await_resolution(
            opts["tenant_id"], escalation["id"], **(opts.get("await_opts") or {})
        )
        if resolved["status"] == "rejected":
            raise PharosBlockedError("rejected by reviewer")
        claim = governor.claim(opts["tenant_id"], escalation["id"])
        if not claim["claimed"]:
            raise PharosBlockedError("already resumed elsewhere (exactly-once)")
        modified = (claim.get("resolution") or {}).get("modifiedAction")
        return tool(modified if modified else args)

    return wrapped
