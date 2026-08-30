from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Optional
from ..substrate.ports import Clock
from ..substrate.events import EventType
from ..executor.engine import RunContext, GatePaused, FatalError
from ..kir.schema import Node


class BudgetAction(str, Enum):
    WARN = "warn"
    PAUSE = "pause"
    KILL = "kill"


@dataclass(frozen=True)
class Budget:
    max_usd: Optional[float] = None
    max_tokens: Optional[int] = None
    max_steps: Optional[int] = None
    max_wallclock_s: Optional[float] = None
    action: BudgetAction = BudgetAction.PAUSE
    warn_at: float = 0.8

    @staticmethod
    def default() -> "Budget":
        # Ships with EVERY run unless explicitly overridden. 'unlimited' must be a
        # literal Budget(max_usd=None, ...) written on purpose.
        return Budget(max_usd=5.0, max_steps=100, action=BudgetAction.PAUSE)


@dataclass
class Meter:
    usd: float = 0.0
    tokens: int = 0
    steps: int = 0
    started_monotonic: float = 0.0


class BudgetExceeded(Exception):
    def __init__(self, scope: str, dimension: str, limit: float, action: BudgetAction) -> None:
        super().__init__(f"budget {scope}.{dimension} exceeded (limit={limit})")
        self.scope = scope
        self.dimension = dimension
        self.action = action


class Budgeter:
    """Nested scopes (tenant -> run -> crew -> node). would_breach() is a pure
    predicate so the executor can decide-then-act atomically; commit() applies a
    spend across all ancestor scopes. There is no spend path that bypasses this."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._budgets: dict[str, Budget] = {}
        self._meters: dict[str, Meter] = {}
        self._warned: set[str] = set()

    def register(self, scope: str, budget: Budget) -> None:
        self._budgets[scope] = budget
        self._meters[scope] = Meter(started_monotonic=self._clock.monotonic())

    def seed(self, scope: str, usd: float, tokens: int, steps: int) -> None:
        """Pre-load a scope's meter with spend already committed before this process
        (used on resume so budgets remain honest across a crash/restart)."""
        m = self._meters.get(scope)
        if m is not None:
            m.usd, m.tokens, m.steps = usd, tokens, steps

    def meter(self, scope: str) -> Optional[Meter]:
        return self._meters.get(scope)

    def _scopes_for(self, node_scope: str) -> list[str]:
        parts = node_scope.split("/")
        return ["/".join(parts[: i + 1]) for i in range(len(parts))]

    def would_breach(self, node_scope: str, add_usd: float, add_tokens: int) -> Optional[BudgetExceeded]:
        for scope in self._scopes_for(node_scope):
            b = self._budgets.get(scope)
            m = self._meters.get(scope)
            if not b or not m:
                continue
            if b.max_usd is not None and m.usd + add_usd > b.max_usd:
                return BudgetExceeded(scope, "usd", b.max_usd, b.action)
            if b.max_tokens is not None and m.tokens + add_tokens > b.max_tokens:
                return BudgetExceeded(scope, "tokens", b.max_tokens, b.action)
            if b.max_steps is not None and m.steps + 1 > b.max_steps:
                return BudgetExceeded(scope, "steps", b.max_steps, b.action)
            if b.max_wallclock_s is not None:
                if self._clock.monotonic() - m.started_monotonic > b.max_wallclock_s:
                    return BudgetExceeded(scope, "wallclock", b.max_wallclock_s, b.action)
        return None

    def commit_spend(self, node_scope: str, usd: float, tokens: int) -> None:
        """Charge cost/tokens to every ancestor scope. Called from RunContext.emit
        for each cost-bearing event, so retries and crew-region spend all land here."""
        for scope in self._scopes_for(node_scope):
            m = self._meters.get(scope)
            if m is not None:
                m.usd += usd
                m.tokens += tokens

    def commit_step(self, node_scope: str) -> None:
        """Count one completed step against every ancestor scope."""
        for scope in self._scopes_for(node_scope):
            m = self._meters.get(scope)
            if m is not None:
                m.steps += 1

    def new_warnings(self, node_scope: str) -> list[str]:
        """Scopes that have crossed warn_at since last asked (each warns once)."""
        out: list[str] = []
        for scope in self._scopes_for(node_scope):
            b, m = self._budgets.get(scope), self._meters.get(scope)
            if not b or not m or scope in self._warned:
                continue
            crossed = (
                (b.max_usd is not None and m.usd >= b.warn_at * b.max_usd)
                or (b.max_tokens is not None and m.tokens >= b.warn_at * b.max_tokens)
                or (b.max_steps is not None and m.steps >= b.warn_at * b.max_steps)
            )
            if crossed:
                self._warned.add(scope)
                out.append(scope)
        return out


class BudgetInterceptor:
    """Bridges the Budgeter to the executor's StepInterceptor protocol. Spend itself
    is metered in RunContext.emit (the chokepoint), so this only (a) halts at a step
    boundary if a limit is already breached, and (b) counts the step + emits warnings.
    Because enforcement is checked in ``before_step`` (which the executor wraps), a
    breach halts within one step boundary of the limit. PAUSE reuses gate parking, so
    raising the budget and re-enqueuing resumes exactly where it stopped.
    """

    def __init__(self, budgeter: Budgeter) -> None:
        self._b = budgeter

    async def before_step(self, ctx: RunContext, node: Node) -> Node | None:
        scope = ctx.scope_for(node.id)
        for w in self._b.new_warnings(scope):
            await ctx.emit(EventType.BUDGET_WARNING, node_id=node.id,
                           data={"scope": w, "kind": "threshold"})
        breach = self._b.would_breach(scope, 0.0, 0)
        if breach is not None:
            await self._act(ctx, node, breach)
        return None

    async def after_step(self, ctx: RunContext, node: Node, cost_usd: float,
                         tokens_in: int, tokens_out: int) -> None:
        self._b.commit_step(ctx.scope_for(node.id))
        for w in self._b.new_warnings(ctx.scope_for(node.id)):
            await ctx.emit(EventType.BUDGET_WARNING, node_id=node.id,
                           data={"scope": w, "kind": "threshold"})

    async def _act(self, ctx: RunContext, node: Node, breach: BudgetExceeded) -> None:
        if breach.action == BudgetAction.WARN:
            await ctx.emit(EventType.BUDGET_WARNING, node_id=node.id,
                           data={"scope": breach.scope, "dimension": breach.dimension})
            return
        if breach.action == BudgetAction.PAUSE:
            await ctx.emit(EventType.BUDGET_EXCEEDED, node_id=node.id,
                           data={"scope": breach.scope, "dimension": breach.dimension,
                                 "action": "pause"})
            await ctx.emit(EventType.RUN_PAUSED)
            ctx.state.status = "paused"
            raise GatePaused(f"budget:{breach.scope}")
        await ctx.emit(EventType.BUDGET_EXCEEDED, node_id=node.id,
                       data={"scope": breach.scope, "dimension": breach.dimension,
                             "action": "kill"})
        raise FatalError(f"budget killed at {breach.scope}.{breach.dimension}")
