"""DX -> KIR lowering (L4).

The authoring layer (L5) is sugar; the executor only ever runs KIR. To keep the
layering honest, the lowering here operates on a *neutral* declarative spec made of
plain frozen models defined in this layer — never on L5's ``Agent``/``Task``/``Crew``
classes (that would be an upward import). L5 translates its fluent objects into this
spec and calls ``compile_crew``.

The lowering is total and deterministic: same spec in, byte-identical KIR out, which
is what makes the golden KIR snapshot test stable.
"""
from __future__ import annotations
from typing import Optional, Literal
from pydantic import BaseModel, ConfigDict, Field
from .schema import Graph, Node, Edge, NodeType, Retry, NodeBudget, Region


class AgentSpec(BaseModel):
    model_config = ConfigDict(frozen=True)
    id: str
    role: str
    goal: str = ""
    model_policy: str = "default"
    system: Optional[str] = None
    allowed_tools: list[str] = Field(default_factory=list)


class TaskSpec(BaseModel):
    model_config = ConfigDict(frozen=True)
    id: str
    description: str
    agent: AgentSpec
    kind: Literal["llm", "tool", "gate"] = "llm"
    tool: Optional[str] = None
    output_schema: Optional[str] = None
    depends_on: list[str] = Field(default_factory=list)
    retry: Retry = Field(default_factory=Retry)
    budget: NodeBudget = Field(default_factory=NodeBudget)
    config_extra: dict[str, str] = Field(default_factory=dict)


class CrewSpec(BaseModel):
    model_config = ConfigDict(frozen=True)
    graph_id: str
    tasks: list[TaskSpec]
    region: Optional["RegionSpec"] = None


class RegionSpec(BaseModel):
    model_config = ConfigDict(frozen=True)
    max_steps: int = 50
    max_tokens: int = 200_000
    allowed_tools: list[str] = Field(default_factory=list)
    output_schema: str = ""
    tasks: list[TaskSpec] = Field(default_factory=list)


def _system_for(agent: AgentSpec) -> str:
    parts = [f"You are the {agent.role}."]
    if agent.goal:
        parts.append(f"Your goal: {agent.goal}.")
    if agent.system:
        parts.append(agent.system)
    return " ".join(parts)


def _node_for(task: TaskSpec) -> Node:
    node_type = {
        "llm": NodeType.LLM_STEP,
        "tool": NodeType.TOOL_STEP,
        "gate": NodeType.HUMAN_GATE,
    }[task.kind]
    config: dict[str, object] = {
        "prompt": task.description,
        "system": _system_for(task.agent),
        "agent": task.agent.id,
    }
    config.update(task.config_extra)
    return Node(
        id=task.id,
        type=node_type,
        model_policy=task.agent.model_policy,
        tool=task.tool,
        output_schema=task.output_schema,
        retry=task.retry,
        budget=task.budget,
        config=config,
    )


def _edges_for(tasks: list[TaskSpec]) -> list[Edge]:
    edges: list[Edge] = []
    for t in tasks:
        for dep in t.depends_on:
            edges.append(Edge.model_validate({"from": dep, "to": t.id}))
    return edges


def compile_crew(spec: CrewSpec) -> Graph:
    """Lower a CrewSpec to a validated KIR Graph. Dependency order becomes edges;
    a task with no declared deps is a source node. The Graph validator enforces
    acyclicity and edge integrity, so authoring mistakes surface here, not at run
    time."""
    nodes = [_node_for(t) for t in spec.tasks]
    edges = _edges_for(spec.tasks)
    if spec.region is not None:
        region = Region(
            max_steps=spec.region.max_steps,
            max_tokens=spec.region.max_tokens,
            allowed_tools=spec.region.allowed_tools,
            output_schema=spec.region.output_schema,
            nodes=[_node_for(t) for t in spec.region.tasks],
            edges=_edges_for(spec.region.tasks),
        )
        crew_node = Node(id=f"{spec.graph_id}.crew", type=NodeType.CREW, region=region)
        nodes.append(crew_node)
    return Graph(graph_id=spec.graph_id, nodes=nodes, edges=edges)


CrewSpec.model_rebuild()
RegionSpec.model_rebuild()
