"""Out-of-process sandbox backend for the tool gateway (P4-3)."""
from __future__ import annotations
import asyncio
import json
import sys
from typing import Any, Protocol, runtime_checkable
from .contract import ToolContract
from .sandbox_runner import SENTINEL


class SandboxViolation(Exception):
    pass


@runtime_checkable
class Sandbox(Protocol):
    async def run(self, module: str, args: dict[str, Any],
                  contract: ToolContract) -> dict[str, Any]: ...


class SubprocessSandbox:
    """Runs a tool in a child Python process under capability gating. The child is
    spawned fresh per call (no shared state), reads its job on stdin, and reports a
    result or a denial on stdout."""

    def __init__(self, python: str | None = None) -> None:
        self._python = python or sys.executable

    async def run(self, module: str, args: dict[str, Any],
                  contract: ToolContract) -> dict[str, Any]:
        payload = json.dumps({
            "module": module, "args": args,
            "limits": {"allow_network": contract.allow_network,
                       "allow_fs_read": contract.allow_fs_read,
                       "allow_fs_write": contract.allow_fs_write},
        }).encode()
        proc = await asyncio.create_subprocess_exec(
            self._python, "-m", "keel.services.tools.sandbox_runner",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(payload),
                                            timeout=contract.timeout_s)
        except asyncio.TimeoutError as e:
            proc.kill()
            raise SandboxViolation("tool timed out") from e

        line = next((ln for ln in out.decode("utf-8", "replace").splitlines()
                     if ln.startswith(SENTINEL)), None)
        if line is None:
            raise SandboxViolation("tool produced no result (crashed in sandbox)")
        result: dict[str, Any] = json.loads(line[len(SENTINEL):])
        if result.get("denied"):
            raise SandboxViolation(str(result.get("reason", "denied")))
        return result["result"]  # type: ignore[no-any-return]
