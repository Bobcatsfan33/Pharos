"""P2-8: events project onto OTel GenAI spans with token attributes and correct
nesting (steps are children of their run). Skipped without keel[otel]."""
import pytest

pytest.importorskip("opentelemetry")
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter)

from keel.kir.schema import Graph, Node, Edge, NodeType  # noqa: E402
from keel.substrate.otel import OTelEventExporter  # noqa: E402
from keel.services.runner import Runner  # noqa: E402
from keel.services.model.handlers import MockModelPort  # noqa: E402


@pytest.mark.asyncio
async def test_spans_have_token_attrs_and_nest():
    provider = TracerProvider()
    mem = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(mem))
    exporter = OTelEventExporter(provider.get_tracer("test"))

    runner = await Runner.open(in_memory=True, model=MockModelPort(), otel=exporter)
    graph = Graph(
        graph_id="g",
        nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "anthropic:claude-haiku-4-5"}),
               Node(id="b", type=NodeType.LLM_STEP, config={"model": "anthropic:claude-haiku-4-5"})],
        edges=[Edge.model_validate({"from": "a", "to": "b"})],
    )
    await runner.run(graph, run_id="otelrun")
    await runner.close()

    spans = {s.name: s for s in mem.get_finished_spans()}
    run_span = spans["keel.run otelrun"]
    step_a = spans["keel.step a"]
    assert step_a.attributes["gen_ai.usage.input_tokens"] == 10
    assert step_a.attributes["gen_ai.usage.output_tokens"] == 5
    assert step_a.attributes["gen_ai.system"] == "anthropic"
    # step span is a child of the run span (correct nesting)
    assert step_a.parent.span_id == run_span.context.span_id
