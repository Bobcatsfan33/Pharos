from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
from ...substrate.events import EventType
from ...executor.engine import RunContext
from ...kir.schema import Node
from .port import ModelPort, ModelRequest, ModelResponse, ModelError


@dataclass(frozen=True)
class Candidate:
    model: str
    max_cost_per_call_usd: float
    capabilities: frozenset[str]


@dataclass(frozen=True)
class ModelPolicy:
    name: str
    candidates: tuple[Candidate, ...]
    escalate_on: frozenset[str]


class Router:
    """Resolves a KIR model_policy to a concrete model at runtime, emitting a
    route.decided event explaining every choice."""

    def __init__(self, policies: dict[str, ModelPolicy], ports: dict[str, ModelPort],
                 default_policy_name: str = "default") -> None:
        self._policies = policies
        self._ports = ports
        self._default_policy_name = default_policy_name

    @staticmethod
    def _provider_of(model: str) -> str:
        return model.split(":", 1)[0]

    async def complete(self, ctx: RunContext, node: Node, req: ModelRequest,
                       required_caps: frozenset[str],
                       under_budget_pressure: bool = False,
                       escalate: int = 0) -> ModelResponse:
        name = node.model_policy if node.model_policy != "default" else self._default_policy_name
        policy = self._policies[name]
        capable = [(i, c) for i, c in enumerate(policy.candidates)
                   if required_caps.issubset(c.capabilities)]
        if not capable:
            raise ModelError("permanent", "no capable candidate in policy")

        # On a prior validation failure, climb the ladder if the policy opts in;
        # under budget pressure, never climb to a pricier candidate.
        start = 0
        reason = "first_capable"
        if escalate > 0 and "validation_failure" in policy.escalate_on \
                and not under_budget_pressure:
            start = min(escalate, len(capable) - 1)
            reason = "escalation:validation_failure"

        last_error: Optional[Exception] = None
        for pos in range(start, len(capable)):
            i, cand = capable[pos]
            req.model = cand.model
            await ctx.emit(EventType.ROUTE_DECIDED, node_id=node.id, data={
                "policy": policy.name, "chosen": cand.model, "rank": i,
                "reason": reason if pos == start else "fallback",
                "escalate": escalate, "budget_pressure": under_budget_pressure})
            try:
                return await self._ports[self._provider_of(cand.model)].complete(req)
            except ModelError as e:
                last_error = e
                if e.taxonomy in ("auth", "permanent", "context_length"):
                    raise
                continue  # transient/overloaded -> fall through to next candidate
        raise last_error or ModelError("permanent", "no capable candidate in policy")
