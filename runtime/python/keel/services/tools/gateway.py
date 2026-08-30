"""In-process tool gateway (Phase 1).

The gateway is the single chokepoint every tool call flows through. It validates
the input against the contract, enforces allowed-agent and rate limits, runs the
tool under a timeout and output-size cap, then validates the output *before* it can
reach an agent. A denied or malformed call emits ``tool.denied`` and never returns
data to the model. P4-3 swaps the in-process executor for an out-of-process seccomp
sandbox behind this exact interface.
"""
from __future__ import annotations
import asyncio
import inspect
import json
from collections import deque
from typing import Any, TYPE_CHECKING
from ...substrate.events import EventType
from ...executor.engine import RunContext
from ...kir.schemas_registry import resolve_schema
from ...executor.effects import tool_args_key
from .contract import RegisteredTool, ToolDenied
from .sandbox import Sandbox, SandboxViolation

if TYPE_CHECKING:
    from ..policy import PolicyEngine


class _RateLimiter:
    """Sliding 60s window per tool. Uses the run clock so replay is deterministic."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = {}

    def check(self, name: str, per_min: int, now: float) -> bool:
        q = self._hits.setdefault(name, deque())
        while q and now - q[0] > 60.0:
            q.popleft()
        if len(q) >= per_min:
            return False
        q.append(now)
        return True


class ToolGateway:
    def __init__(self, tools: dict[str, RegisteredTool],
                 sandbox: "Sandbox | None" = None,
                 policy: "PolicyEngine | None" = None) -> None:
        self._tools = tools
        self._rl = _RateLimiter()
        self._sandbox = sandbox
        self._policy = policy

    def names(self) -> list[str]:
        return sorted(self._tools)

    async def invoke(self, ctx: RunContext, agent_id: str, tool_name: str,
                     args: dict[str, Any], node_id: str | None = None) -> bytes:
        tool = self._tools.get(tool_name)
        if tool is None:
            await self._deny(ctx, tool_name, "unknown_tool")
            raise ToolDenied(tool_name, "unknown_tool")
        c = tool.contract

        if c.allowed_agents and agent_id not in c.allowed_agents:
            await self._deny(ctx, tool_name, "agent_not_allowed", {"agent": agent_id})
            raise ToolDenied(tool_name, "agent_not_allowed", agent_id)

        in_model = resolve_schema(c.input_schema)
        try:
            validated_in = in_model.model_validate(args).model_dump() if in_model else args
        except Exception as e:  # noqa: BLE001
            await self._deny(ctx, tool_name, "invalid_input", {"detail": str(e)})
            raise ToolDenied(tool_name, "invalid_input", str(e)) from e

        # Side-effect-once: a tool call already committed to the log replays from the
        # ledger (no re-execution, no re-emit). An effect that started but never
        # committed (a crash mid-tool) follows the contract's recovery policy.
        key = tool_args_key(node_id or tool_name, validated_in)
        if ctx.ledger is not None:
            committed = ctx.ledger.committed_tool(key)
            if committed is not None:
                return committed
            if ctx.ledger.tool_in_flight(key) and not c.idempotent:
                await self._deny(ctx, tool_name, "effect_in_flight",
                                 {"detail": "non-idempotent tool crashed mid-effect"})
                raise ToolDenied(tool_name, "effect_in_flight",
                                 "non-idempotent tool started but never committed")

        # Policy + RBAC at the boundary (emits policy.violation on its own).
        if self._policy is not None:
            from ..policy import PolicyContext, PolicyViolation
            try:
                await self._policy.enforce(ctx, PolicyContext(
                    principal=agent_id, action="tool_call", tool=tool_name,
                    args=validated_in))
            except PolicyViolation as e:
                raise ToolDenied(tool_name, "policy_violation", str(e)) from e

        if not self._rl.check(tool_name, c.rate_limit_per_min, ctx.clock.monotonic()):
            await self._deny(ctx, tool_name, "rate_limited")
            raise ToolDenied(tool_name, "rate_limited")

        await ctx.emit(EventType.TOOL_REQUEST, node_id=node_id,
                       payload=json.dumps(validated_in, sort_keys=True).encode(),
                       data={"tool": tool_name, "side_effect": c.side_effect.value,
                             "agent": agent_id, "idem": key})
        try:
            if c.module and self._sandbox is not None:
                # Out-of-process under capability gating (the sandbox enforces its own
                # timeout); undeclared fs/network access is blocked there.
                raw_result = await self._sandbox.run(c.module, validated_in, c)
            else:
                raw_result = await asyncio.wait_for(
                    self._run_impl(tool, validated_in), timeout=c.timeout_s)
        except asyncio.TimeoutError as e:
            await self._deny(ctx, tool_name, "timeout")
            raise ToolDenied(tool_name, "timeout") from e
        except SandboxViolation as e:
            await self._deny(ctx, tool_name, "sandbox_violation", {"detail": str(e)})
            raise ToolDenied(tool_name, "sandbox_violation", str(e)) from e

        out_bytes = json.dumps(raw_result, sort_keys=True).encode()
        if len(out_bytes) > c.max_output_bytes:
            await self._deny(ctx, tool_name, "output_too_large",
                             {"bytes": str(len(out_bytes))})
            raise ToolDenied(tool_name, "output_too_large", str(len(out_bytes)))

        out_model = resolve_schema(c.output_schema)
        if out_model is not None:
            try:
                out_bytes = out_model.model_validate(raw_result).model_dump_json().encode()
            except Exception as e:  # noqa: BLE001 — validation barrier before any prompt
                await self._deny(ctx, tool_name, "invalid_output", {"detail": str(e)})
                raise ToolDenied(tool_name, "invalid_output", str(e)) from e

        await ctx.emit(EventType.TOOL_RESPONSE, node_id=node_id, payload=out_bytes,
                       data={"tool": tool_name, "idem": key})
        return out_bytes

    async def _run_impl(self, tool: RegisteredTool, args: dict[str, Any]) -> dict[str, Any]:
        result = tool.impl(args)
        if inspect.isawaitable(result):
            result = await result
        if not isinstance(result, dict):
            raise ToolDenied(tool.contract.name, "non_dict_output")
        return result

    async def _deny(self, ctx: RunContext, tool_name: str, reason: str,
                    extra: dict[str, str] | None = None) -> None:
        data: dict[str, Any] = {"tool": tool_name, "reason": reason}
        if extra:
            data.update(extra)
        await ctx.emit(EventType.TOOL_DENIED, data=data)


def make_tool_handler(gateway: ToolGateway) -> Any:
    """Handler for ``tool_step`` nodes. Args come from the node config merged with
    upstream JSON outputs (upstream wins), the agent id from config."""

    async def handle(ctx: RunContext, node: Any, inputs: dict[str, bytes]) -> bytes:
        assert node.tool, "tool_step without a tool slipped past the KIR validator"
        args: dict[str, Any] = dict(node.config.get("args", {}))
        for _src, raw in sorted(inputs.items()):
            try:
                upstream = json.loads(raw)
                if isinstance(upstream, dict):
                    args.update(upstream)
            except json.JSONDecodeError:
                pass
        agent_id = str(node.config.get("agent", "system"))
        return await gateway.invoke(ctx, agent_id, node.tool, args, node_id=node.id)

    return handle
