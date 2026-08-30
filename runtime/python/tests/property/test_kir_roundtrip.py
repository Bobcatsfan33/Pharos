"""P1-1: KIR round-trips losslessly through JSON for arbitrary valid graphs, and
the validator accepts every well-formed graph the generator produces."""
from hypothesis import given, strategies as st, settings
from keel.kir.schema import Graph, Node, Edge, NodeType

_SAFE_TYPES = [NodeType.LLM_STEP, NodeType.MAP, NodeType.REDUCE, NodeType.ROUTER]


@st.composite
def valid_graphs(draw) -> Graph:
    n = draw(st.integers(min_value=1, max_value=8))
    ids = [f"n{i}" for i in range(n)]
    nodes = []
    for i in ids:
        ntype = draw(st.sampled_from(_SAFE_TYPES))
        nodes.append(Node(id=i, type=ntype,
                          output_schema=draw(st.sampled_from([None, "ref:schemas/X"]))))
    # Only forward edges (i -> j, i < j) so the graph is acyclic by construction.
    edges = []
    for a in range(n):
        for b in range(a + 1, n):
            if draw(st.booleans()):
                edges.append(Edge.model_validate({"from": ids[a], "to": ids[b]}))
    return Graph(graph_id=draw(st.text(min_size=1, max_size=12).filter(str.strip)),
                 nodes=nodes, edges=edges)


@settings(max_examples=200)
@given(g=valid_graphs())
def test_graph_roundtrips_losslessly(g: Graph):
    raw = g.model_dump_json()
    back = Graph.model_validate_json(raw)
    assert back.model_dump() == g.model_dump()
    assert back.model_dump_json() == raw  # byte-stable


@settings(max_examples=100)
@given(g=valid_graphs())
def test_generated_graphs_are_acyclic_and_valid(g: Graph):
    # Construction already passed the validator (acyclic, edge integrity); assert the
    # node-id set is unique and every edge endpoint exists.
    ids = {n.id for n in g.nodes}
    assert len(ids) == len(g.nodes)
    for e in g.edges:
        assert e.from_ in ids and e.to in ids
