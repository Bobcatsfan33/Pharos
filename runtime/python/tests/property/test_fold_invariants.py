from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.executor.state import RunState
from keel.substrate.events import Event, EventType
from datetime import datetime, timezone


def _g():
    return Graph(graph_id="g",
                 nodes=[Node(id="a", type=NodeType.LLM_STEP), Node(id="b", type=NodeType.LLM_STEP)],
                 edges=[Edge.model_validate({"from": "a", "to": "b"})])


def _seq(types_nodes):
    out, i = [], 0
    for t, n in types_nodes:
        out.append(Event(event_id=f"e{i}", run_id="r", seq=i,
                         ts=datetime.now(timezone.utc), type=t, node_id=n))
        i += 1
    return out


def test_frontier_excludes_completed():
    g = _g()
    events = _seq([(EventType.RUN_STARTED, None),
                   (EventType.STEP_SCHEDULED, "a"), (EventType.STEP_STARTED, "a"),
                   (EventType.STEP_COMPLETED, "a")])
    st = RunState.fold("r", g, events)
    assert "a" not in st.frontier()
    assert st.frontier() == ["b"]  # b now runnable, a done -> never re-run


def test_fold_rejects_seq_gap():
    g = _g()
    bad = [Event(event_id="e0", run_id="r", seq=0, ts=datetime.now(timezone.utc),
                 type=EventType.RUN_STARTED),
           Event(event_id="e2", run_id="r", seq=2, ts=datetime.now(timezone.utc),
                 type=EventType.STEP_SCHEDULED, node_id="a")]
    try:
        RunState.fold("r", g, bad)
        assert False, "expected gap rejection"
    except ValueError as e:
        assert "gap" in str(e)
