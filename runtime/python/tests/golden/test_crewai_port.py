"""P1-8: a CrewAI researcher+writer pipeline ports in <=25 lines and lowers to a
stable KIR snapshot. If the lowering changes, this test fails loudly (the golden
contract)."""
import json
from pathlib import Path

from keel.authoring import Agent, Task, Crew

GOLDEN = Path(__file__).parent / "research_pipeline.kir.json"


def build_graph():
    # --- begin port (counted lines) ---
    researcher = Agent("researcher", goal="Find the key facts on the topic")
    writer = Agent("writer", goal="Write a clear summary from the research")
    research = Task("Research the topic thoroughly", agent=researcher,
                    output_schema="ref:schemas/Notes")
    write = Task("Write the article from the research", agent=writer, context=[research])
    return Crew("research_pipeline", tasks=[research, write]).compile()
    # --- end port ---


def test_port_is_short():
    src = Path(__file__).read_text().splitlines()
    begin = next(i for i, ln in enumerate(src) if "begin port" in ln)
    end = next(i for i, ln in enumerate(src) if "end port" in ln)
    assert (end - begin - 1) <= 25


def test_lowering_matches_golden():
    graph = build_graph()
    actual = json.loads(graph.model_dump_json())
    if not GOLDEN.exists():  # first run records the snapshot
        GOLDEN.write_text(json.dumps(actual, indent=2, sort_keys=True))
    expected = json.loads(GOLDEN.read_text())
    assert actual == expected, (
        "KIR lowering drifted from golden snapshot. If intentional, delete "
        f"{GOLDEN.name} and re-run to re-record."
    )


def test_structure():
    graph = build_graph()
    assert graph.graph_id == "research_pipeline"
    ids = {n.id for n in graph.nodes}
    assert ids == {"research_the_topic_thoroughly", "write_the_article_from"}
    # edges encode the dependency: research -> write
    assert [(e.from_, e.to) for e in graph.edges] == \
        [("research_the_topic_thoroughly", "write_the_article_from")]
    research_node = next(n for n in graph.nodes if n.id == "research_the_topic_thoroughly")
    assert research_node.output_schema == "ref:schemas/Notes"
    assert "researcher" in research_node.config["system"]
