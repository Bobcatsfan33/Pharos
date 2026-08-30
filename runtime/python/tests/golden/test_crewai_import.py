"""P4-7: a CrewAI agents.yaml + tasks.yaml project imports to KIR, preserving roles,
descriptions, and task->task context dependencies."""
import pytest

from keel.authoring.import_crewai import crew_from_specs, unconverted

AGENTS = {
    "researcher": {"role": "Senior Researcher", "goal": "Find facts on {topic}",
                   "backstory": "You are thorough."},
    "writer": {"role": "Tech Writer", "goal": "Write a clear article"},
}
TASKS = {
    "research_task": {"description": "Research {topic} deeply", "agent": "researcher"},
    "write_task": {"description": "Write the article from the research",
                   "agent": "writer", "context": ["research_task"]},
}


def test_import_preserves_structure_and_deps():
    graph = crew_from_specs(AGENTS, TASKS, graph_id="ported").compile()
    ids = {n.id for n in graph.nodes}
    assert ids == {"research_task", "write_task"}
    # context dependency -> edge
    assert [(e.from_, e.to) for e in graph.edges] == [("research_task", "write_task")]
    research = next(n for n in graph.nodes if n.id == "research_task")
    assert "Senior Researcher" in research.config["system"]
    assert research.config["prompt"] == "Research {topic} deeply"
    assert research.config["agent"] == "researcher"


def test_import_via_yaml_dir(tmp_path):
    yaml = pytest.importorskip("yaml")
    (tmp_path / "agents.yaml").write_text(yaml.safe_dump(AGENTS))
    (tmp_path / "tasks.yaml").write_text(yaml.safe_dump(TASKS))
    from keel.authoring.import_crewai import load_crewai_dir
    graph = load_crewai_dir(str(tmp_path), graph_id="from_yaml").compile()
    assert graph.graph_id == "from_yaml" and len(graph.nodes) == 2


def test_unconverted_features_reported():
    tasks = {"t": {"description": "x", "agent": "researcher", "tools": ["web_search"]}}
    notes = unconverted(AGENTS, tasks)
    assert any("custom tools" in n for n in notes)
