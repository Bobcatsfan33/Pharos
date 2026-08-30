from __future__ import annotations
import json
from typing import Awaitable, Optional, AsyncIterator, Protocol
from pydantic import ValidationError
from ...substrate.events import EventType, TokenUsage
from ...executor.engine import RunContext, FatalError, RetryableError, NodeHandler
from ...kir.schema import Node
from ...kir.schemas_registry import resolve_schema
from .port import ModelPort, ModelRequest, ModelResponse, ModelError
from .pricing import PriceTable
from ..context import ContextCompiler, CompiledContext

MAX_REPROMPTS = 2

# Provider taxonomy -> executor taxonomy. Transient classes become RetryableError so
# the executor's per-node retry/backoff absorbs a rate-limit storm; the rest are fatal
# (context_length is handled upstream by the context compiler, not retried blindly).
_RETRYABLE = {"rate_limit", "overloaded", "transient"}


def _to_executor_error(e: ModelError) -> Exception:
    if e.taxonomy in _RETRYABLE:
        return RetryableError(str(e), taxonomy=e.taxonomy)
    return FatalError(f"{e.taxonomy}: {e}")


class Completer(Protocol):
    """Turns (run context, node, request) into a response. A plain ModelPort becomes
    one via port_completer(); the Router is one (via router_completer). ``escalate``
    is the count of prior validation failures, letting a routed completer climb its
    candidate ladder (cheap -> frontier) when the cheap model can't satisfy the
    schema."""

    def __call__(self, ctx: RunContext, node: Node, req: ModelRequest,
                 escalate: int = 0) -> Awaitable[ModelResponse]: ...


def port_completer(port: ModelPort) -> Completer:
    async def _complete(ctx: RunContext, node: Node, req: ModelRequest,
                        escalate: int = 0) -> ModelResponse:
        return await port.complete(req)
    return _complete


def _compile_context(node: Node, inputs: dict[str, bytes],
                     compiler: "ContextCompiler") -> CompiledContext:
    """Staged, measured prompt assembly (P3-4). Upstream outputs and optional
    history/memory carried in node.config are compiled into messages with a
    per-stage token breakdown."""
    upstream = {k: v.decode("utf-8", errors="replace") for k, v in sorted(inputs.items())}
    history = node.config.get("history") or []
    memory = node.config.get("memory") or []
    return compiler.compile(
        system=str(node.config.get("system", "")),
        role=str(node.config.get("role", "")),
        prompt=str(node.config.get("prompt", "")),
        inputs=json.dumps(upstream, sort_keys=True) if upstream else "",
        history=history if isinstance(history, list) else [],
        memory=memory if isinstance(memory, list) else [],
    )


def make_llm_handler(
    model: "ModelPort | Completer",
    price_per_1k: Optional[tuple[float, float]] = None,
    *,
    price_table: Optional[PriceTable] = None,
    compiler: Optional[ContextCompiler] = None,
) -> NodeHandler:
    """Build a handler for ``llm_step`` nodes.

    Emits an ``llm.request``/``llm.response`` pair per attempt with tokens and cost
    attached (invariant #1), and — when the node declares ``output_schema`` —
    enforces it with a bounded re-prompt loop that feeds the validator's own error
    back to the model. The step ends in typed success or a typed failure event;
    malformed output never reaches a downstream node (P1-7). The prompt is built by
    the staged, measured context compiler (P3-4).
    """
    completer: Completer = port_completer(model) if isinstance(model, ModelPort) else model
    stream_port: Optional[ModelPort] = model if isinstance(model, ModelPort) else None
    table = price_table or (
        _FlatTable(price_per_1k) if price_per_1k is not None else PriceTable()
    )
    cc = compiler or ContextCompiler()

    async def handle(ctx: RunContext, node: Node, inputs: dict[str, bytes]) -> bytes:
        compiled = _compile_context(node, inputs, cc)
        if node.config.get("stream") and stream_port is not None:
            return await _streamed(ctx, node, compiled, stream_port, table)
        base_messages = compiled.messages
        schema_model = resolve_schema(node.output_schema)
        req = ModelRequest(
            model=str(node.config.get("model", "mock:test")),
            messages=[dict(m) for m in base_messages],
            max_tokens=node.budget.max_tokens or 4096,
            temperature=float(node.config.get("temperature", 0.0)),
            response_schema=schema_model.model_json_schema() if schema_model else None,
        )

        # On resume, calls already committed to the log replay from the effect ledger:
        # they are not re-issued (no provider call), not re-emitted (the original events
        # stand), and not re-billed (their cost is already in the folded totals).
        recorded = ctx.ledger.recorded_model_responses(node.id) if ctx.ledger else []

        last_err: str | None = None
        for attempt in range(MAX_REPROMPTS + 1):
            if attempt < len(recorded):
                rc = recorded[attempt]
                resp = ModelResponse(text=rc.text, tokens_in=rc.tokens_in,
                                     tokens_out=rc.tokens_out, model=rc.model)
            else:
                await ctx.emit(
                    EventType.LLM_REQUEST, node_id=node.id,
                    payload=json.dumps(req.messages).encode(),
                    data={"model": req.model, "reprompt": attempt,
                          "context_tokens": compiled.stage_tokens,
                          "context_total": compiled.total_tokens},
                )
                # escalate=attempt: each schema failure climbs the policy's candidate
                # ladder (when the policy escalates on validation_failure).
                try:
                    resp = await completer(ctx, node, req, escalate=attempt)
                except ModelError as e:
                    raise _to_executor_error(e) from e
                await ctx.emit(
                    EventType.LLM_RESPONSE, node_id=node.id,
                    payload=resp.text.encode(),
                    tokens=TokenUsage(input=resp.tokens_in, output=resp.tokens_out,
                                      model=resp.model),
                    cost_usd=table.cost(resp),
                )

            if schema_model is None:
                return resp.text.encode()
            try:
                validated = schema_model.model_validate_json(resp.text)
                return validated.model_dump_json().encode()
            except ValidationError as ve:
                last_err = _summarize_validation_error(ve)
                req.messages = [dict(m) for m in base_messages] + [
                    {"role": "assistant", "content": resp.text},
                    {"role": "user",
                     "content": f"Your output failed schema validation:\n{last_err}\n"
                                "Return ONLY valid JSON matching the schema."},
                ]

        raise FatalError(
            f"structured_output_unsatisfied after {MAX_REPROMPTS} reprompts: {last_err}"
        )

    return handle


async def _streamed(ctx: RunContext, node: Node, compiled: CompiledContext,
                    port: ModelPort, table: PriceTable) -> bytes:
    """Streaming path: assemble the token/chunk stream into the final result and emit a
    single llm.response (final + a deterministic stream summary). The final result is
    byte-identical on replay; live stream timing is not persisted. Side-effect-once:
    a committed call replays from the ledger without re-streaming."""
    recorded = ctx.ledger.recorded_model_responses(node.id) if ctx.ledger else []
    if recorded:
        return recorded[0].text.encode()
    req = ModelRequest(model=str(node.config.get("model", "mock:test")),
                       messages=[dict(m) for m in compiled.messages],
                       max_tokens=node.budget.max_tokens or 4096)
    await ctx.emit(EventType.LLM_REQUEST, node_id=node.id,
                   payload=json.dumps(req.messages).encode(),
                   data={"model": req.model, "streaming": True})
    chunks: list[str] = []
    async for chunk in port.stream(req):
        chunks.append(chunk)
    final = "".join(chunks)
    resp = ModelResponse(text=final, tokens_in=compiled.total_tokens,
                         tokens_out=port.count_tokens(final, req.model), model=req.model)
    await ctx.emit(
        EventType.LLM_RESPONSE, node_id=node.id, payload=final.encode(),
        tokens=TokenUsage(input=resp.tokens_in, output=resp.tokens_out, model=resp.model),
        cost_usd=table.cost(resp), data={"streamed": True, "final_sha": _sha(final)})
    return final.encode()


def _sha(text: str) -> str:
    import hashlib
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _summarize_validation_error(ve: ValidationError) -> str:
    parts = []
    for err in ve.errors()[:6]:
        loc = ".".join(str(p) for p in err.get("loc", ()))
        parts.append(f"{loc}: {err.get('msg', '')}")
    return "; ".join(parts)


class _FlatTable(PriceTable):
    """A PriceTable that applies one (in, out) rate to every model — used by the
    legacy ``price_per_1k`` argument."""

    def __init__(self, rate: tuple[float, float]) -> None:
        super().__init__(prices={})
        self._flat = rate

    def rate(self, model: str) -> tuple[float, float]:
        return self._flat


# --------------------------------------------------------------------------- #
# Test / dev model doubles
# --------------------------------------------------------------------------- #
class MockModelPort:
    """Deterministic dev/test model. Counts calls so tests can assert that resumed
    runs do NOT re-invoke completed steps."""

    def __init__(self, reply: str = '{"ok": true}') -> None:
        self.reply = reply
        self.calls = 0

    async def complete(self, req: ModelRequest) -> ModelResponse:
        self.calls += 1
        return ModelResponse(text=self.reply, tokens_in=10, tokens_out=5, model=req.model)

    async def stream(self, req: ModelRequest) -> AsyncIterator[str]:
        yield self.reply

    def count_tokens(self, text: str, model: str) -> int:
        return max(1, len(text) // 4)


class ScriptedModelPort:
    """Returns a scripted sequence of replies, then repeats the last. Lets a chaos
    test drive the structured-output re-prompt loop: malformed, malformed, valid."""

    def __init__(self, replies: list[str]) -> None:
        if not replies:
            raise ValueError("ScriptedModelPort needs at least one reply")
        self._replies = replies
        self.calls = 0

    async def complete(self, req: ModelRequest) -> ModelResponse:
        text = self._replies[min(self.calls, len(self._replies) - 1)]
        self.calls += 1
        return ModelResponse(text=text, tokens_in=10, tokens_out=5, model=req.model)

    async def stream(self, req: ModelRequest) -> AsyncIterator[str]:
        yield self._replies[min(self.calls, len(self._replies) - 1)]

    def count_tokens(self, text: str, model: str) -> int:
        return max(1, len(text) // 4)


class AdversarialModelPort:
    """Always returns output that fails the schema. The handler must converge to a
    typed FatalError, never leak malformed output downstream."""

    def __init__(self, bad: str = "not json at all {{{") -> None:
        self._bad = bad
        self.calls = 0

    async def complete(self, req: ModelRequest) -> ModelResponse:
        self.calls += 1
        return ModelResponse(text=self._bad, tokens_in=10, tokens_out=5, model=req.model)

    async def stream(self, req: ModelRequest) -> AsyncIterator[str]:
        yield self._bad

    def count_tokens(self, text: str, model: str) -> int:
        return max(1, len(text) // 4)


__all__ = [
    "make_llm_handler", "port_completer", "Completer", "MAX_REPROMPTS",
    "MockModelPort", "ScriptedModelPort", "AdversarialModelPort",
]
