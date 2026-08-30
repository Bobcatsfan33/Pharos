"""Framework adapters (M4) — run LangGraph / CrewAI / OpenAI Agents / Anthropic agents
*under* KEEL for durability, tracing, budgets, and byte-identical replay.

Every adapter expresses a framework agent as a graph of ``AgentNode``s whose model calls
flow through a ``TracedModel``; ``assert_conforms`` is the one suite every adapter passes.
"""
from .base import AgentNode, AgentRun, TracedModel, run_agent, replay_agent, to_graph
from .conformance import assert_conforms, ConformanceReport

__all__ = [
    "AgentNode", "AgentRun", "TracedModel", "run_agent", "replay_agent", "to_graph",
    "assert_conforms", "ConformanceReport",
]
