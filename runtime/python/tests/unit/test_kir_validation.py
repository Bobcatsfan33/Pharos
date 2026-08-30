import pytest
from keel.kir.schema import Graph, Node, Edge, NodeType


def test_rejects_dangling_edge_naming_node():
    with pytest.raises(ValueError, match="unknown node 'ghost'"):
        Graph(graph_id="g", nodes=[Node(id="a", type=NodeType.LLM_STEP)],
              edges=[Edge.model_validate({"from": "a", "to": "ghost"})])


def test_rejects_cycle_naming_node():
    with pytest.raises(ValueError, match="cycle through node"):
        Graph(graph_id="g",
              nodes=[Node(id="a", type=NodeType.LLM_STEP), Node(id="b", type=NodeType.LLM_STEP)],
              edges=[Edge.model_validate({"from": "a", "to": "b"}),
                     Edge.model_validate({"from": "b", "to": "a"})])


def test_tool_step_requires_tool():
    with pytest.raises(ValueError, match="tool_step requires"):
        Node(id="t", type=NodeType.TOOL_STEP)


def test_deep_chain_validates_without_recursion_error():
    # Acyclicity is checked iteratively (Kahn), so a very deep chain doesn't blow
    # the recursion limit.
    n = 3000
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP) for i in range(n)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(n - 1)]
    g = Graph(graph_id="deep", nodes=nodes, edges=edges)
    assert len(g.nodes) == n


def test_deep_cycle_still_detected():
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP) for i in range(500)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(499)]
    edges.append(Edge.model_validate({"from": "s499", "to": "s0"}))  # back-edge -> cycle
    with pytest.raises(ValueError, match="cycle through node"):
        Graph(graph_id="cyc", nodes=nodes, edges=edges)
