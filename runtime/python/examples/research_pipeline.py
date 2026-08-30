"""Headline example — a graph in KIR (the IR the executor runs), no framework DSL.

    python examples/research_pipeline.py        # runs against the deterministic mock
    keel run --mock examples/research_pipeline.py
    keel view                                   # browse the trace

KEEL is durable execution for LLM agents: this run is an append-only event log that
resumes after a crash from its last completed step, replays byte-identically, and
never re-bills a completed model call. The example exposes a module-level ``graph``
(a KIR ``Graph``) so ``keel run`` can execute it directly. The optional authoring DSL
lives in ``examples/authoring_dsl.py``.
"""
import asyncio

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort

graph = Graph(
    graph_id="research_pipeline",
    nodes=[
        Node(id="research", type=NodeType.LLM_STEP, config={
            "model": "anthropic:claude-haiku-4-5",
            "system": "You are a careful researcher.",
            "prompt": "Research the topic thoroughly and list the key facts."}),
        Node(id="write", type=NodeType.LLM_STEP, config={
            "model": "anthropic:claude-haiku-4-5",
            "system": "You are a clear technical writer.",
            "prompt": "Write a short, sourced summary from the research."}),
    ],
    edges=[Edge.model_validate({"from": "research", "to": "write"})],
)


async def main() -> None:
    runner = await Runner.open(in_memory=True, model=MockModelPort(reply='{"summary": "done"}'))
    state = await runner.run(graph, run_id="example-1")
    await runner.close()
    print(f"run {state.run_id} -> {state.status}")
    print("steps:", {k: v.status for k, v in state.steps.items()})
    print(f"cost ${state.total_cost_usd:.6f}  tokens "
          f"{state.total_tokens_in}->{state.total_tokens_out}")


if __name__ == "__main__":
    asyncio.run(main())
