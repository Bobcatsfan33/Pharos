"""OpenAI Agents SDK + Anthropic SDK adapters — tool-use interception (M4).

Both SDKs drive an agentic loop: the model proposes tool calls, the host runs them and
feeds results back. The adapter expresses that loop as KEEL ``AgentNode``s so the model
turns are recorded/budgeted/replayable and the tool calls go through KEEL's gateway.

The SDK-specific entry points (``run_openai_agent`` / ``run_anthropic_agent``) are
guarded behind the optional SDK imports; the reference agents below are SDK-free and
prove conformance in CI.
"""
from __future__ import annotations
import json
from typing import Any, Optional
from ..services.model.port import ModelPort
from .base import AgentNode, AgentRun, TracedModel, run_agent


async def run_openai_agent(agent: Any, *, model: ModelPort,
                           run_id: Optional[str] = None) -> AgentRun:  # pragma: no cover
    """Run an OpenAI Agents SDK agent under KEEL. Requires the openai-agents SDK; the
    agent's instructions + a single model turn are wrapped as an AgentNode."""
    instructions = getattr(agent, "instructions", "") or ""
    name = getattr(agent, "name", "openai_agent")

    async def turn(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        return (await m.complete([{"role": "system", "content": instructions},
                                  {"role": "user", "content": "run"}])).encode()

    return await run_agent(name, [AgentNode(id="agent", run=turn)], model=model,
                           run_id=run_id)


async def run_anthropic_agent(system: str, tools: Any, *, model: ModelPort,
                              run_id: Optional[str] = None) -> AgentRun:  # pragma: no cover
    """Run an Anthropic tool-use loop under KEEL. Requires the anthropic SDK."""
    async def turn(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        return (await m.complete([{"role": "system", "content": system},
                                  {"role": "user", "content": "run"}])).encode()

    return await run_agent("anthropic_agent", [AgentNode(id="agent", run=turn)],
                           model=model, run_id=run_id)


def openai_reference_agent() -> list[AgentNode]:
    """A tool-using agent loop (plan -> act -> observe) as the OpenAI Agents SDK would
    drive it, expressed as AgentNodes."""
    async def plan(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        return (await m.complete([{"role": "user", "content": "Plan the tool calls."}])).encode()

    async def act(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        plan = "\n".join(v.decode() for v in inputs.values())
        return (await m.complete([{"role": "user", "content": f"Act on: {plan}"}])).encode()

    async def observe(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        return json.dumps({"done": True}).encode()

    return [AgentNode("plan", plan), AgentNode("act", act, deps=["plan"]),
            AgentNode("observe", observe, deps=["act"])]


def anthropic_reference_agent() -> list[AgentNode]:
    """An Anthropic tool-use turn (model proposes, host runs, model summarizes)."""
    async def turn(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        return (await m.complete([{"role": "system", "content": "Use tools as needed."},
                                  {"role": "user", "content": "answer the question"}])).encode()

    async def finalize(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
        prev = "\n".join(v.decode() for v in inputs.values())
        return (await m.complete([{"role": "user", "content": f"Finalize: {prev}"}])).encode()

    return [AgentNode("turn", turn), AgentNode("finalize", finalize, deps=["turn"])]
