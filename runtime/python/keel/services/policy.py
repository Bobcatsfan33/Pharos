"""Policy engine + RBAC (P4-5).

Policies are evaluated in L3 at the runtime boundary the executor must cross to act —
NOT injected as prompt suggestions an agent might ignore. A violation is a typed
``policy.violation`` event and (by default) blocks the action. There is therefore no
"the model decided to ignore the instruction" failure mode: enforcement is
structural, on the path to the side effect.

Rules are small, composable predicates over a ``PolicyContext`` (RBAC over roles,
argument allowlists, custom callables). First deny wins.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Protocol, runtime_checkable
from ..substrate.events import EventType
from ..executor.engine import RunContext


@dataclass(frozen=True)
class PolicyContext:
    principal: str
    action: str                      # 'run' | 'approve' | 'replay' | 'tool_call'
    graph_id: str = ""
    tool: Optional[str] = None
    args: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Decision:
    allow: bool
    reason: str = ""


@runtime_checkable
class Rule(Protocol):
    name: str
    def evaluate(self, pc: PolicyContext) -> Decision: ...


class PolicyViolation(Exception):
    def __init__(self, rule: str, reason: str) -> None:
        super().__init__(f"{rule}: {reason}")
        self.rule = rule
        self.reason = reason


@dataclass
class RolePolicy:
    allowed_actions: frozenset[str] = field(default_factory=frozenset)
    allowed_tools: frozenset[str] = field(default_factory=frozenset)
    deny_tools: frozenset[str] = field(default_factory=frozenset)


class RBAC:
    """Role-based access: a principal's role gates which actions and tools it may
    perform. An empty allowed_tools means 'no tools'; '*' means all."""

    name = "rbac"

    def __init__(self, roles: dict[str, RolePolicy], principals: dict[str, str],
                 default_role: str = "") -> None:
        self._roles = roles
        self._principals = principals
        self._default = default_role

    def evaluate(self, pc: PolicyContext) -> Decision:
        role_name = self._principals.get(pc.principal, self._default)
        role = self._roles.get(role_name)
        if role is None:
            return Decision(False, f"principal '{pc.principal}' has no role")
        if pc.action != "tool_call" and pc.action not in role.allowed_actions:
            return Decision(False, f"role '{role_name}' may not '{pc.action}'")
        if pc.action == "tool_call" and pc.tool is not None:
            if pc.tool in role.deny_tools:
                return Decision(False, f"role '{role_name}' is denied tool '{pc.tool}'")
            if "*" not in role.allowed_tools and pc.tool not in role.allowed_tools:
                return Decision(False, f"role '{role_name}' may not call '{pc.tool}'")
        return Decision(True)


class ArgSuffixAllowlist:
    """For a given tool, an argument's value must end with one of the allowed
    suffixes (e.g. send_email.to must end with '@company.com')."""

    def __init__(self, tool: str, arg: str, suffixes: list[str]) -> None:
        self.name = f"arg_allowlist:{tool}.{arg}"
        self._tool = tool
        self._arg = arg
        self._suffixes = tuple(suffixes)

    def evaluate(self, pc: PolicyContext) -> Decision:
        if pc.tool != self._tool:
            return Decision(True)
        value = str(pc.args.get(self._arg, ""))
        if not value.endswith(self._suffixes):
            return Decision(False, f"{self._tool}.{self._arg}='{value}' not in allowlist")
        return Decision(True)


class CallableRule:
    def __init__(self, name: str, fn: Callable[[PolicyContext], Decision]) -> None:
        self.name = name
        self._fn = fn

    def evaluate(self, pc: PolicyContext) -> Decision:
        return self._fn(pc)


class PolicyEngine:
    def __init__(self, rules: list[Rule], fatal_on_violation: bool = True) -> None:
        self._rules = rules
        self._fatal = fatal_on_violation

    async def enforce(self, ctx: RunContext, pc: PolicyContext) -> None:
        for rule in self._rules:
            decision = rule.evaluate(pc)
            if not decision.allow:
                await ctx.emit(EventType.POLICY_VIOLATION, node_id=pc.tool, data={
                    "principal": pc.principal, "action": pc.action,
                    "graph_id": pc.graph_id, "tool": pc.tool,
                    "rule": rule.name, "reason": decision.reason})
                if self._fatal:
                    raise PolicyViolation(rule.name, decision.reason)
                return
