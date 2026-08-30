"""Minimal KIR graph governed by Pharos at every durable step boundary."""

from keel.kir.schema import Edge, Graph, Node, NodeType


graph = Graph(
    graph_id="pharos_governed_research",
    nodes=[
        Node(
            id="research",
            type=NodeType.LLM_STEP,
            config={
                "prompt": "Summarize the incident notes.",
                "pharos": {
                    "action_type": "analysis.summarize",
                    "oversight_mode": "autonomous",
                    "reversibility": "reversible",
                    "payload": {"dataClass": "internal", "purpose": "incident-review"},
                },
            },
        ),
        Node(
            id="publish",
            type=NodeType.LLM_STEP,
            config={
                "prompt": "Prepare the approved external summary.",
                "pharos": {
                    "action_type": "message.send",
                    "oversight_mode": "human_in_loop",
                    "reversibility": "irreversible",
                    "payload": {
                        "body": "Patient John Smith was diagnosed with HIV and started therapy.",
                        "dataClass": "synthetic-phi",
                        "destination": "external",
                    },
                },
            },
        ),
    ],
    edges=[Edge.model_validate({"from": "research", "to": "publish"})],
)
