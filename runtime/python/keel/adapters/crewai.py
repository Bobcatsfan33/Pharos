"""CrewAI adapter — execute a crew *live* under KEEL (M4).

Phase 4 shipped a CrewAI *importer* (YAML -> KIR). This adapter takes the next step:
it executes a crew live on KEEL's durable executor, so a CrewAI agent gains resume,
replay, budgets, and tracing. Each task becomes an ``AgentNode`` whose ``run`` builds
the role/goal prompt and calls the KEEL-backed ``TracedModel``; dependencies become the
graph's edges.

Interception boundary: the agents' *model calls* are routed through KEEL (recorded,
budgeted, replayable). Framework-internal nondeterminism (a custom Python tool that
reads the clock, say) is outside KEEL's view unless that tool is run through the KEEL
tool gateway — documented, not hidden.
"""
from __future__ import annotations
from typing import Any, Optional
from ..services.model.port import ModelPort
from ..services.model.pricing import PriceTable
from .base import AgentNode, AgentRun, NodeRun, TracedModel, run_agent


def _system(agent: dict[str, Any]) -> str:
    parts = [f"You are the {agent.get('role', 'agent')}."]
    if agent.get("goal"):
        parts.append(f"Goal: {agent['goal']}.")
    if agent.get("backstory"):
        parts.append(str(agent["backstory"]))
    return " ".join(parts)


def from_specs(agents: dict[str, Any], tasks: dict[str, Any]) -> list[AgentNode]:
    """Translate CrewAI agents.yaml + tasks.yaml shapes into AgentNodes (live)."""
    nodes: list[AgentNode] = []
    for key, spec in tasks.items():
        spec = spec or {}
        agent = agents.get(str(spec.get("agent") or ""), {}) or {}
        sys = _system(agent)
        desc = str(spec.get("description", key))
        deps = [c for c in spec.get("context", []) if c in tasks]

        def make_run(system: str, prompt: str) -> NodeRun:
            async def run(model: TracedModel, inputs: dict[str, bytes]) -> bytes:
                upstream = "\n".join(v.decode("utf-8", "replace") for v in inputs.values())
                user = prompt if not upstream else f"{prompt}\n\nContext:\n{upstream}"
                text = await model.complete(
                    [{"role": "system", "content": system}, {"role": "user", "content": user}])
                return text.encode()
            return run

        nodes.append(AgentNode(id=key, run=make_run(sys, desc), deps=deps))
    return nodes


async def run_crew(agents: dict[str, Any], tasks: dict[str, Any], *, model: ModelPort,
                   graph_id: str = "crewai_agent", run_id: Optional[str] = None,
                   price_table: Optional[PriceTable] = None) -> AgentRun:
    return await run_agent(graph_id, from_specs(agents, tasks), model=model,
                           run_id=run_id, price_table=price_table)


def reference_agent() -> list[AgentNode]:
    """A runnable 2-agent research crew, as the adapter would translate it."""
    agents = {
        "researcher": {"role": "Senior Researcher", "goal": "Find the key facts"},
        "writer": {"role": "Tech Writer", "goal": "Write a clear summary"},
    }
    tasks = {
        "research": {"description": "Research the topic", "agent": "researcher"},
        "write": {"description": "Write the article from the research", "agent": "writer",
                  "context": ["research"]},
    }
    return from_specs(agents, tasks)
