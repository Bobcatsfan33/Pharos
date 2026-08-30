"""Typed tool contracts. A tool declares its input/output schema (as registry
refs), side-effect class, and resource limits up front. The gateway validates
inputs before execution and outputs *before* they can reach an agent prompt
(invariant: typed in, typed out). Phase 1 runs tools in-process; the out-of-process
seccomp sandbox is P4-3 — the contract is identical either way.
"""
from __future__ import annotations
from enum import Enum
from typing import Awaitable, Callable, Optional
from pydantic import BaseModel, ConfigDict


class SideEffect(str, Enum):
    READ = "read"
    WRITE = "write"
    IRREVERSIBLE = "irreversible"  # never auto-retried without an idempotency key


class ToolContract(BaseModel):
    model_config = ConfigDict(frozen=True)
    name: str
    input_schema: str               # ref:schemas/...
    output_schema: str              # ref:schemas/...
    # "pkg.module:function" — when set with a sandbox configured, the tool runs
    # out-of-process under capability gating instead of as an in-process callable.
    module: Optional[str] = None
    side_effect: SideEffect = SideEffect.READ
    idempotent: bool = True
    rate_limit_per_min: int = 60
    allowed_agents: list[str] = []  # empty = all
    timeout_s: float = 30.0
    max_output_bytes: int = 1_000_000
    # Declared resource access (enforced by the sandbox in P4; recorded now).
    allow_network: list[str] = []
    allow_fs_read: list[str] = []
    allow_fs_write: list[str] = []


# A tool implementation maps a validated input model to a result dict.
ToolImpl = Callable[[dict[str, object]], Awaitable[dict[str, object]] | dict[str, object]]


class RegisteredTool(BaseModel):
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)
    contract: ToolContract
    impl: ToolImpl

    def with_impl(self, impl: ToolImpl) -> "RegisteredTool":
        return RegisteredTool(contract=self.contract, impl=impl)


def tool(contract: ToolContract) -> Callable[[ToolImpl], RegisteredTool]:
    """Decorator: bind an implementation to a contract.

        @tool(ToolContract(name="search", input_schema="ref:schemas/Q",
                           output_schema="ref:schemas/Hits"))
        async def search(args): ...
    """
    def _wrap(impl: ToolImpl) -> RegisteredTool:
        return RegisteredTool(contract=contract, impl=impl)
    return _wrap


class ToolError(Exception):
    pass


class ToolDenied(ToolError):
    def __init__(self, tool_name: str, reason: str, detail: Optional[str] = None) -> None:
        super().__init__(f"{tool_name}: {reason}" + (f" ({detail})" if detail else ""))
        self.tool_name = tool_name
        self.reason = reason
        self.detail = detail
