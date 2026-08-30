"""Node-type handlers beyond ``llm_step`` plus the ``default_handlers`` assembler.

The executor (L2) only knows how to schedule the frontier; the *semantics* of each
node type live here in L3 as handlers it is given. This is what lets KEEL add node
types without touching the runtime.

  * router   — emits a ``route.decided`` event; outgoing edges guarded ``branch:<x>``
  * map      — fans an input list out (records count); per-item work belongs in a region
  * reduce   — aggregates an item list with a named op
  * crew /   — runs a bounded autonomous region as a sub-run, hard-capped by the
    subgraph   region contract (max_steps / max_tokens) so it always terminates
"""
from __future__ import annotations
import json
from typing import Any, Optional, Callable
from ..substrate.events import EventType
from ..substrate.store.memory import MemoryEventStore
from ..kir.schema import Graph, Node, NodeType
from ..kir.schemas_registry import resolve_schema
from ..executor.engine import RunContext, Executor, NodeHandler, FatalError
from ..executor.state import RunState
from ..executor.gate import human_gate_handler
from .budget import Budgeter, Budget, BudgetAction, BudgetInterceptor
from .model.handlers import make_llm_handler, port_completer, Completer
from .model.port import ModelPort, ModelRequest, ModelResponse
from .model.router import Router
from .tools.gateway import ToolGateway, make_tool_handler


# --------------------------------------------------------------------------- #
# router / map / reduce
# --------------------------------------------------------------------------- #
def make_router_handler() -> NodeHandler:
    async def handle(ctx: RunContext, node: Node, inputs: dict[str, bytes]) -> bytes:
        branch = node.config.get("branch")
        if branch is None:
            branch = node.config.get("default_branch", "")
        branch = str(branch)
        await ctx.emit(EventType.ROUTE_DECIDED, node_id=node.id,
                       data={"chosen_branch": branch,
                             "reason": str(node.config.get("reason", "static"))})
        return json.dumps({"branch": branch}).encode()
    return handle


def _merge_inputs(inputs: dict[str, bytes]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for _src, raw in sorted(inputs.items()):
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            merged.update(obj)
    return merged


def make_map_handler() -> NodeHandler:
    async def handle(ctx: RunContext, node: Node, inputs: dict[str, bytes]) -> bytes:
        key = str(node.config.get("over", "items"))
        merged = _merge_inputs(inputs)
        items = merged.get(key, node.config.get("items", []))
        if not isinstance(items, list):
            raise FatalError(f"map node {node.id}: '{key}' is not a list")
        return json.dumps({"items": items, "count": len(items)}).encode()
    return handle


_REDUCERS: dict[str, Callable[[list[Any]], Any]] = {
    "count": lambda xs: len(xs),
    "sum": lambda xs: sum(xs),
    "join": lambda xs: "".join(str(x) for x in xs),
    "concat": lambda xs: list(xs),
    "first": lambda xs: xs[0] if xs else None,
    "last": lambda xs: xs[-1] if xs else None,
}


def make_reduce_handler() -> NodeHandler:
    async def handle(ctx: RunContext, node: Node, inputs: dict[str, bytes]) -> bytes:
        op = str(node.config.get("reduce", "count"))
        if op not in _REDUCERS:
            raise FatalError(f"reduce node {node.id}: unknown op '{op}'")
        merged = _merge_inputs(inputs)
        items = merged.get("items", [])
        if not isinstance(items, list):
            raise FatalError(f"reduce node {node.id}: expected 'items' list")
        return json.dumps({"result": _REDUCERS[op](items)}).encode()
    return handle


# --------------------------------------------------------------------------- #
# crew / subgraph: bounded autonomous region as a sub-run
# --------------------------------------------------------------------------- #
def make_region_handler(handlers: dict[NodeType, NodeHandler]) -> NodeHandler:
    """Runs ``node.region`` as a sub-run on the same trace bus and blob store, so
    its internal steps are fully traced under a child run id. The region contract
    (max_steps / max_tokens) is enforced as a KILL budget — the boundary is rigid
    even though agents self-organize inside it (the Flows-vs-Crews answer)."""

    async def handle(ctx: RunContext, node: Node, inputs: dict[str, bytes]) -> bytes:
        region = node.region
        assert region is not None, "crew/subgraph without region slipped past KIR validator"
        subgraph = Graph(graph_id=f"{node.id}:region", nodes=list(region.nodes),
                         edges=list(region.edges))
        child_run_id = f"{ctx.run_id}::{node.id}"
        child_scope = f"{ctx.scope_for(node.id)}/crew"

        # Share the parent's budgeter so crew-internal spend composes up to the run
        # and tenant scopes — there is no spend path inside a region that bypasses the
        # enclosing budget (P3-1 no-bypass). The region's own contract is an extra
        # KILL budget on the crew scope.
        budgeter = ctx.budgeter if isinstance(ctx.budgeter, Budgeter) else Budgeter(ctx.clock)
        budgeter.register(child_scope, Budget(
            max_steps=region.max_steps, max_tokens=region.max_tokens,
            action=BudgetAction.KILL))
        interceptor = BudgetInterceptor(budgeter)

        child_state = RunState(run_id=child_run_id, graph=subgraph)
        # Region source nodes read their own config-injected prompts; the crew inputs
        # are already available to them via config.
        child_ctx = RunContext(child_run_id, ctx.clock, ctx.ids, ctx.rng, ctx.blobs,
                               ctx.bus, child_state, scope=child_scope, budgeter=budgeter)
        sub_exec = Executor(MemoryEventStore(), ctx.bus, ctx.blobs, handlers,
                            interceptors=[interceptor])
        final = await sub_exec.run(subgraph, child_ctx)

        if final.status != "completed":
            raise FatalError(f"crew region {node.id} ended {final.status}")

        out = _collect_region_output(final, ctx)
        out_model = resolve_schema(region.output_schema)
        if out_model is not None:
            try:
                return out_model.model_validate_json(out).model_dump_json().encode()
            except Exception as e:  # noqa: BLE001
                raise FatalError(
                    f"crew region {node.id} output failed {region.output_schema}: {e}") from e
        return out

    return handle


def _collect_region_output(final: RunState, ctx: RunContext) -> bytes:
    """The region's output is its sink nodes' results. One sink → its bytes; many →
    a JSON object keyed by node id."""
    sinks = [n.id for n in final.graph.nodes
             if not any(e.from_ == n.id for e in final.graph.edges)]
    completed = [s for s in sinks
                 if (r := final.steps.get(s)) and r.status == "completed" and r.result_ref]
    if len(completed) == 1:
        ref = final.steps[completed[0]].result_ref
        assert ref is not None
        return ctx.blobs.get(ref)
    obj: dict[str, Any] = {}
    for s in completed:
        ref = final.steps[s].result_ref
        assert ref is not None
        raw = ctx.blobs.get(ref)
        try:
            obj[s] = json.loads(raw)
        except json.JSONDecodeError:
            obj[s] = raw.decode("utf-8", "replace")
    return json.dumps(obj).encode()


# --------------------------------------------------------------------------- #
# completer adapters + assembler
# --------------------------------------------------------------------------- #
async def _no_model_handler(ctx: RunContext, node: Node, inputs: dict[str, bytes]) -> bytes:
    raise FatalError(
        f"llm_step '{node.id}' has no model configured; open the runtime with a "
        "model=, completer=, or router=")


def router_completer(router: Router, required_caps: frozenset[str] = frozenset()) -> Completer:
    async def _complete(ctx: RunContext, node: Node, req: ModelRequest,
                        escalate: int = 0) -> ModelResponse:
        return await router.complete(ctx, node, req, required_caps, escalate=escalate)
    return _complete


def default_handlers(
    *,
    model: Optional[ModelPort] = None,
    completer: Optional[Completer] = None,
    router: Optional[Router] = None,
    gateway: Optional[ToolGateway] = None,
    price_table: Any = None,
) -> dict[NodeType, NodeHandler]:
    """Assemble the full node-type handler table the executor runs against. Exactly
    one of model / completer / router supplies LLM completions."""
    handlers: dict[NodeType, NodeHandler] = {}
    if router is not None:
        handlers[NodeType.LLM_STEP] = make_llm_handler(router_completer(router),
                                                       price_table=price_table)
    elif completer is not None:
        handlers[NodeType.LLM_STEP] = make_llm_handler(completer, price_table=price_table)
    elif model is not None:
        handlers[NodeType.LLM_STEP] = make_llm_handler(model, price_table=price_table)
    else:
        # No model wired (e.g. a read-only runner for ls/show/diff). Installing a
        # handler that fails loudly *only if an llm_step is actually executed* keeps
        # runner construction cheap without silently degrading a real run.
        handlers[NodeType.LLM_STEP] = _no_model_handler
    handlers[NodeType.HUMAN_GATE] = human_gate_handler
    handlers[NodeType.ROUTER] = make_router_handler()
    handlers[NodeType.MAP] = make_map_handler()
    handlers[NodeType.REDUCE] = make_reduce_handler()
    if gateway is not None:
        handlers[NodeType.TOOL_STEP] = make_tool_handler(gateway)
    region = make_region_handler(handlers)  # closes over the (now-populated) table
    handlers[NodeType.CREW] = region
    handlers[NodeType.SUBGRAPH] = region
    return handlers


# keep port_completer reachable for callers building a one-model handler table
__all__ = [
    "default_handlers", "make_router_handler", "make_map_handler", "make_reduce_handler",
    "make_region_handler", "router_completer", "port_completer",
]
