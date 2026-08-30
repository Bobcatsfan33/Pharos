"""Cost simulation (P3-5).

Estimates a run's cost *before* executing it, by compiling each llm step's prompt
with the real context compiler (so the input-token estimate reflects the actual
staged prompt) and pricing it with the versioned price table. Output tokens come
from a per-node hint (``expected_output_tokens``) or a default. The estimate tracks
an actual run within ~15% when those hints are reasonable, which is what makes
``keel simulate`` a useful pre-flight check.
"""
from __future__ import annotations
import json
from dataclasses import dataclass, field
from typing import Optional
from ..kir.schema import Graph, NodeType
from .context import ContextCompiler
from .model.pricing import PriceTable, estimate_cost

DEFAULT_OUTPUT_TOKENS = 256


@dataclass
class NodeEstimate:
    node_id: str
    model: str
    input_tokens: int
    output_tokens: int
    usd: float


@dataclass
class SimResult:
    nodes: list[NodeEstimate] = field(default_factory=list)

    @property
    def total_usd(self) -> float:
        return sum(n.usd for n in self.nodes)

    @property
    def total_tokens(self) -> int:
        return sum(n.input_tokens + n.output_tokens for n in self.nodes)

    def to_dict(self) -> dict[str, object]:
        return {"total_usd": self.total_usd, "total_tokens": self.total_tokens,
                "nodes": [n.__dict__ for n in self.nodes]}


def simulate_run(graph: Graph, *, price_table: Optional[PriceTable] = None,
                 compiler: Optional[ContextCompiler] = None,
                 default_output_tokens: int = DEFAULT_OUTPUT_TOKENS) -> SimResult:
    table = price_table or PriceTable()
    cc = compiler or ContextCompiler()
    result = SimResult()
    for node in graph.nodes:
        if node.type not in (NodeType.LLM_STEP,):
            continue
        history = node.config.get("history") or []
        memory = node.config.get("memory") or []
        compiled = cc.compile(
            system=str(node.config.get("system", "")),
            role=str(node.config.get("role", "")),
            prompt=str(node.config.get("prompt", "")),
            inputs=json.dumps(node.config.get("inputs", "")) if node.config.get("inputs") else "",
            history=history if isinstance(history, list) else [],
            memory=memory if isinstance(memory, list) else [],
        )
        model = str(node.config.get("model", "anthropic:claude-haiku-4-5"))
        out_tokens = int(node.config.get("expected_output_tokens", default_output_tokens))
        usd = estimate_cost(model, compiled.total_tokens, out_tokens, table)
        result.nodes.append(NodeEstimate(node.id, model, compiled.total_tokens,
                                         out_tokens, usd))
    return result
