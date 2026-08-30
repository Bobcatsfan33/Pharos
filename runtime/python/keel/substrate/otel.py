"""OpenTelemetry GenAI export (P2-8).

Projects the event stream onto OTel spans following the GenAI semantic conventions:
a span per run, a child span per step, and token/cost attributes attached from the
``llm.response`` events. Nesting is real (steps are children of their run), so the
trace shows up correctly in Datadog / Tempo / Jaeger. Requires ``keel[otel]``.

The exporter implements the trace bus's ``OTelExporter`` protocol (sync ``export``)
and is resilient: an event referencing an unknown span is ignored, never raised.
"""
from __future__ import annotations
from typing import Any, Optional
from .events import Event, EventType

_TERMINAL_RUN = {EventType.RUN_COMPLETED, EventType.RUN_FAILED, EventType.RUN_CANCELLED}
_TERMINAL_STEP = {EventType.STEP_COMPLETED, EventType.STEP_FAILED, EventType.STEP_SKIPPED}


class OTelEventExporter:
    def __init__(self, tracer: Any) -> None:
        self._tracer = tracer
        from opentelemetry import trace
        self._trace = trace
        self._run_spans: dict[str, Any] = {}
        self._step_spans: dict[tuple[str, str], Any] = {}

    def export(self, e: Event) -> None:
        if e.type == EventType.RUN_STARTED:
            span = self._tracer.start_span(f"keel.run {e.run_id}")
            span.set_attribute("keel.run_id", e.run_id)
            self._run_spans[e.run_id] = span
        elif e.type in _TERMINAL_RUN:
            span = self._run_spans.pop(e.run_id, None)
            if span is not None:
                span.set_attribute("keel.status", e.type.value)
                span.end()
        elif e.type == EventType.STEP_STARTED and e.node_id:
            run_span = self._run_spans.get(e.run_id)
            ctx = self._trace.set_span_in_context(run_span) if run_span else None
            span = self._tracer.start_span(f"keel.step {e.node_id}", context=ctx)
            span.set_attribute("keel.node_id", e.node_id)
            span.set_attribute("keel.attempt", e.attempt)
            self._step_spans[(e.run_id, e.node_id)] = span
        elif e.type == EventType.LLM_RESPONSE and e.node_id:
            span = self._step_spans.get((e.run_id, e.node_id))
            if span is not None and e.tokens is not None:
                span.set_attribute("gen_ai.system", _system_of(e.tokens.model))
                span.set_attribute("gen_ai.request.model", e.tokens.model)
                span.set_attribute("gen_ai.usage.input_tokens", e.tokens.input)
                span.set_attribute("gen_ai.usage.output_tokens", e.tokens.output)
                span.set_attribute("keel.cost_usd", e.cost_usd)
        elif e.type in _TERMINAL_STEP and e.node_id:
            span = self._step_spans.pop((e.run_id, e.node_id), None)
            if span is not None:
                span.set_attribute("keel.status", e.type.value)
                span.end()


def _system_of(model: str) -> str:
    return model.split(":", 1)[0] if ":" in model else "unknown"


def make_otel_exporter(tracer_provider: Optional[Any] = None) -> OTelEventExporter:
    from opentelemetry import trace
    provider = tracer_provider or trace.get_tracer_provider()
    return OTelEventExporter(provider.get_tracer("keel"))
