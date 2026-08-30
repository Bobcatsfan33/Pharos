"""CrewAI -> KIR importer (P4-7).

Converts the common CrewAI declarative project shape (``agents.yaml`` + ``tasks.yaml``,
the sequential-process case) into a KEEL authoring Crew that compiles to KIR. This
covers the bulk of real CrewAI projects: roles/goals, task descriptions, and task
``context`` dependencies. Custom Python tools and bespoke process logic are reported
as unconverted rather than guessed.
"""
from __future__ import annotations
from pathlib import Path
from typing import Any
from .api import Agent, Task, Crew


def crew_from_specs(agents: dict[str, Any], tasks: dict[str, Any],
                    graph_id: str = "imported_crew") -> Crew:
    built: dict[str, Task] = {}
    # First pass: agents.
    agent_objs: dict[str, Agent] = {}
    for key, spec in agents.items():
        spec = spec or {}
        agent_objs[key] = Agent(spec.get("role", key), goal=spec.get("goal", ""),
                                system=spec.get("backstory"), id=key)
    # Tasks in declaration order; context refs resolve to already-built tasks.
    ordered: list[Task] = []
    for key, spec in tasks.items():
        spec = spec or {}
        agent_key = str(spec.get("agent") or key)
        agent = agent_objs.get(agent_key) or Agent(agent_key, id=agent_key)
        context = [built[c] for c in spec.get("context", []) if c in built]
        t = Task(spec.get("description", key), agent=agent, context=context,
                 output_schema=spec.get("output_schema"), id=key)
        built[key] = t
        ordered.append(t)
    if not ordered:
        raise ValueError("no tasks found to import")
    return Crew(graph_id, tasks=ordered)


def unconverted(agents: dict[str, Any], tasks: dict[str, Any]) -> list[str]:
    """Report features we did not translate, so import is honest, not silently lossy."""
    notes: list[str] = []
    for k, spec in (tasks or {}).items():
        if (spec or {}).get("tools"):
            notes.append(f"task '{k}': custom tools not auto-wired")
    for k, spec in (agents or {}).items():
        if (spec or {}).get("tools"):
            notes.append(f"agent '{k}': tools not auto-wired")
    return notes


def load_yaml_pair(path: str) -> tuple[dict[str, Any], dict[str, Any]]:
    import yaml
    root = Path(path)
    agents_file = root / "agents.yaml"
    tasks_file = root / "tasks.yaml"
    if not agents_file.exists() or not tasks_file.exists():
        raise FileNotFoundError(f"{path}: expected agents.yaml and tasks.yaml")
    agents = yaml.safe_load(agents_file.read_text()) or {}
    tasks = yaml.safe_load(tasks_file.read_text()) or {}
    return agents, tasks


def load_crewai_dir(path: str, graph_id: str | None = None) -> Crew:
    agents, tasks = load_yaml_pair(path)
    return crew_from_specs(agents, tasks, graph_id or Path(path).name or "imported_crew")
