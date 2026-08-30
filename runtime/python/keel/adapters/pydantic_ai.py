"""Pydantic-AI adapter — run a typed Pydantic-AI agent under KEEL (M7).

This adapter is also the worked example for *contributing a new adapter* (see
``docs/ADAPTER-AUTHORS.md``): it follows the same shape as every other adapter — a
guarded, SDK-specific entry point plus an SDK-free ``reference_agent`` that proves
conformance in CI — and it is wired into the shared conformance suite, so adding it was
the same mechanical contribution an external author makes.

Pydantic-AI drives a typed agentic loop: an agent with a system prompt produces output
validated against a Pydantic ``result_type``. The adapter expresses that as KEEL
``AgentNode``s whose model turns flow through a ``TracedModel`` — so the run is recorded,
budgeted, and replayable byte-identically, exactly like the first-party frameworks.

Interception boundary: model calls made through the provided model are intercepted;
control flow the framework runs out of band is not, unless routed through KEEL.
"""
from __future__ import annotations

from typing import Any, Optional

from ..services.model.port import ModelPort
from .base import AgentNode, AgentRun, TracedModel, run_agent


async def run_pydantic_agent(agent: Any, *, model: ModelPort,
                             run_id: Optional[str] = None) -> AgentRun:  # pragma: no cover
    """Run a Pydantic-AI ``Agent`` under KEEL. Requires ``keel[pydantic-ai]``. The
    agent's system prompt and a single typed turn are wrapped as an ``AgentNode``; the
    model turn flows through KEEL's ``TracedModel``."""
    system = getattr(agent, "system_prompt", "") or getattr(agent, "_system_prompt", "")
    name = getattr(agent, "name", None) or "pydantic_ai_agent"

    async def turn(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        return (await m.complete([{"role": "system", "content": str(system)},
                                  {"role": "user", "content": "run"}])).encode()

    return await run_agent(str(name), [AgentNode(id="agent", run=turn)], model=model,
                           run_id=run_id)


def reference_agent() -> list[AgentNode]:
    """A typed Pydantic-AI-shaped agent: a generate step whose output a validate step
    refines, as the adapter would translate a typed agent with a ``result_type``."""
    async def generate(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        return (await m.complete([
            {"role": "system", "content": "You return a typed result."},
            {"role": "user", "content": "Produce the structured answer."}])).encode()

    async def validate(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        draft = "\n".join(v.decode() for v in inputs.values())
        return (await m.complete([
            {"role": "user", "content": f"Validate and tighten the typed result: {draft}"}
        ])).encode()

    return [AgentNode("generate", generate),
            AgentNode("validate", validate, deps=["generate"])]
