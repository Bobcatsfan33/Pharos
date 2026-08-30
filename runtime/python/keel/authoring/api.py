"""Authoring API (L5) — CrewAI-comparable ergonomics that compile to KIR.

    from keel.authoring import Agent, Task, Crew

    researcher = Agent("researcher", goal="Find key facts on the topic")
    writer = Agent("writer", goal="Write a clear summary from the research")

    research = Task("Research the topic thoroughly", agent=researcher)
    write = Task("Write the article from the research", agent=writer, context=[research])

    graph = Crew("research_pipeline", tasks=[research, write]).compile()

This layer is pure sugar: ``compile()`` lowers to the neutral CrewSpec and hands it
to the L4 compiler. The executor never sees these classes.
"""
from __future__ import annotations
import re
from typing import Optional, Callable, Any, Literal
from ..kir.schema import Graph, Retry, NodeBudget
from ..kir.compile import AgentSpec, TaskSpec, CrewSpec, RegionSpec, compile_crew

_slug_re = re.compile(r"[^a-z0-9]+")


def _slug(text: str, max_words: int = 4) -> str:
    words = _slug_re.sub(" ", text.lower()).split()
    return "_".join(words[:max_words]) or "node"


class Agent:
    def __init__(self, role: str, *, goal: str = "", model_policy: str = "default",
                 system: Optional[str] = None, tools: Optional[list[str]] = None,
                 id: Optional[str] = None) -> None:
        self.role = role
        self.goal = goal
        self.model_policy = model_policy
        self.system = system
        self.tools = tools or []
        self.id = id or _slug(role)

    def to_spec(self) -> AgentSpec:
        return AgentSpec(id=self.id, role=self.role, goal=self.goal,
                         model_policy=self.model_policy, system=self.system,
                         allowed_tools=list(self.tools))


class Task:
    def __init__(self, description: str, *, agent: Agent,
                 context: Optional[list["Task"]] = None,
                 output_schema: Optional[str] = None, tool: Optional[str] = None,
                 human_gate: bool = False, id: Optional[str] = None,
                 retry: Optional[Retry] = None, budget: Optional[NodeBudget] = None,
                 config: Optional[dict[str, str]] = None) -> None:
        self.description = description
        self.agent = agent
        self.context = context or []
        self.output_schema = output_schema
        self.tool = tool
        self.human_gate = human_gate
        self.id = id or _slug(description)
        self.retry = retry or Retry()
        self.budget = budget or NodeBudget()
        self.config = config or {}

    @property
    def kind(self) -> Literal["llm", "tool", "gate"]:
        if self.human_gate:
            return "gate"
        if self.tool is not None:
            return "tool"
        return "llm"

    def to_spec(self) -> TaskSpec:
        return TaskSpec(
            id=self.id, description=self.description, agent=self.agent.to_spec(),
            kind=self.kind, tool=self.tool, output_schema=self.output_schema,
            depends_on=[t.id for t in self.context],
            retry=self.retry, budget=self.budget, config_extra=dict(self.config),
        )


class Crew:
    def __init__(self, graph_id: str, *, tasks: list[Task]) -> None:
        if not tasks:
            raise ValueError("Crew needs at least one Task")
        self.graph_id = graph_id
        self.tasks = tasks

    def to_spec(self) -> CrewSpec:
        return CrewSpec(graph_id=self.graph_id, tasks=[t.to_spec() for t in self.tasks])

    def compile(self) -> Graph:
        return compile_crew(self.to_spec())


# --------------------------------------------------------------------------- #
# Decorator style (CrewAI familiarity). Methods marked @agent/@task on a CrewBase
# subclass are collected into a Crew by build().
# --------------------------------------------------------------------------- #
def agent(fn: Callable[..., Agent]) -> Callable[..., Agent]:
    setattr(fn, "__keel_role__", "agent")
    return fn


def task(fn: Callable[..., Task]) -> Callable[..., Task]:
    setattr(fn, "__keel_role__", "task")
    return fn


class CrewBase:
    """Subclass and decorate methods with @agent / @task; ``build(graph_id)``
    instantiates them in declaration order and assembles a Crew."""

    graph_id: str = "crew"

    def build(self, graph_id: Optional[str] = None) -> Crew:
        tasks: list[Task] = []
        for name in dir(self):
            attr: Any = getattr(type(self), name, None)
            if callable(attr) and getattr(attr, "__keel_role__", None) == "task":
                result = getattr(self, name)()
                if isinstance(result, Task):
                    tasks.append(result)
        return Crew(graph_id or self.graph_id, tasks=tasks)


__all__ = ["Agent", "Task", "Crew", "CrewBase", "agent", "task", "RegionSpec"]
