"""LangGraph / LangChain adapter — run a compiled graph under KEEL (M4).

Two integration surfaces:

  * ``from_nodes(node_fns, edges)`` — translate a graph whose nodes are already KEEL
    ``NodeRun`` coroutines (the generic, SDK-free path). A LangGraph ``StateGraph`` maps
    onto this directly: each node name -> a coroutine that calls ``model.complete`` and
    returns the node's output; edges -> dependencies.
  * ``keel_chat_model()`` — a LangChain ``BaseChatModel`` (requires ``keel[langchain]``)
    that routes ``_generate`` through the active KEEL run's ``TracedModel``, so an
    *unmodified* LangChain/LangGraph agent that uses this model is recorded and
    replayable. Returned lazily so the import is optional.

Interception boundary: model calls made through the provided model are intercepted;
control flow and any tools the framework runs out of band are not, unless routed
through KEEL.
"""
from __future__ import annotations
from typing import Any, Optional
from ..services.model.port import ModelPort
from ..services.model.pricing import PriceTable
from .base import AgentNode, AgentRun, NodeRun, TracedModel, run_agent


def from_nodes(node_fns: dict[str, NodeRun],
               edges: list[tuple[str, str]]) -> list[AgentNode]:
    deps: dict[str, list[str]] = {name: [] for name in node_fns}
    for src, dst in edges:
        deps[dst].append(src)
    return [AgentNode(id=name, run=fn, deps=deps[name]) for name, fn in node_fns.items()]


async def run_graph(node_fns: dict[str, NodeRun], edges: list[tuple[str, str]], *,
                    model: ModelPort, graph_id: str = "langgraph_agent",
                    run_id: Optional[str] = None,
                    price_table: Optional[PriceTable] = None) -> AgentRun:
    return await run_agent(graph_id, from_nodes(node_fns, edges), model=model,
                           run_id=run_id, price_table=price_table)


def keel_chat_model(ctx: Any, node: Any, model: ModelPort,
                    table: Optional[PriceTable] = None) -> Any:
    """A LangChain BaseChatModel routing generation through KEEL. Requires
    ``keel[langchain]``. Bound to the active run context + node."""
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult

    traced = TracedModel(ctx, node, model, table or PriceTable())

    class KeelChatModel(BaseChatModel):  # type: ignore[misc]
        @property
        def _llm_type(self) -> str:
            return "keel"

        async def _agenerate(self, messages: Any, stop: Any = None,
                             run_manager: Any = None, **kw: Any) -> Any:
            msgs = [{"role": getattr(m, "type", "user"), "content": m.content} for m in messages]
            text = await traced.complete(msgs)
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])

        def _generate(self, messages: Any, stop: Any = None,
                      run_manager: Any = None, **kw: Any) -> Any:
            raise NotImplementedError("use the async path under KEEL")

    return KeelChatModel()


def reference_agent() -> list[AgentNode]:
    """A runnable LangGraph-shaped agent: a classifier node fanning into a summarize
    node (a small state graph), as the adapter would translate it."""
    async def classify(model: TracedModel, inputs: dict[str, bytes]) -> bytes:
        text = await model.complete([{"role": "user", "content": "Classify the request."}])
        return text.encode()

    async def summarize(model: TracedModel, inputs: dict[str, bytes]) -> bytes:
        ctx = "\n".join(v.decode() for v in inputs.values())
        text = await model.complete([{"role": "user", "content": f"Summarize: {ctx}"}])
        return text.encode()

    return from_nodes({"classify": classify, "summarize": summarize},
                      edges=[("classify", "summarize")])
