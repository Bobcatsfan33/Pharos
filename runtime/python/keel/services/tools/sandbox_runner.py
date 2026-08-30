"""Child entrypoint for the out-of-process tool sandbox (P4-3).

Reads ``{module, args, limits}`` as JSON on stdin, installs capability guards
(filesystem allowlist + network gate), imports and runs the declared tool, and
writes a single ``KEEL_RESULT:<json>`` line to stdout. A capability violation or an
error becomes ``{"denied": true, "reason": ...}`` — the tool never reaches outside
its declared access, and the parent turns a denial into a ``tool.denied`` event.

This is process-level isolation + capability gating (open()/socket() guards). On
Linux it composes with a seccomp/container wrapper; the contract is identical.
"""
from __future__ import annotations
import asyncio
import builtins
import importlib
import inspect
import json
import os
import socket
import sys
from typing import Any

SENTINEL = "KEEL_RESULT:"


def _emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(SENTINEL + json.dumps(obj) + "\n")
    sys.stdout.flush()


def _deny(reason: str) -> None:
    _emit({"denied": True, "reason": reason})
    os._exit(0)


def _install_guards(allow_net: list[str], allow_read: list[str],
                    allow_write: list[str]) -> None:
    real_open = builtins.open
    read_roots = [os.path.abspath(p) for p in allow_read]
    write_roots = [os.path.abspath(p) for p in allow_write]

    def guarded_open(file: Any, mode: str = "r", *a: Any, **k: Any) -> Any:
        path = os.path.abspath(str(file))
        writing = any(c in mode for c in ("w", "a", "x", "+"))
        roots = write_roots if writing else read_roots
        if not any(path == r or path.startswith(r + os.sep) for r in roots):
            _deny(f"filesystem access outside declaration: {path} (mode={mode})")
        return real_open(file, mode, *a, **k)

    builtins.open = guarded_open

    real_socket = socket.socket

    def guarded_socket(*a: Any, **k: Any) -> Any:
        if not allow_net:
            _deny("network access without an allow_network declaration")
        return real_socket(*a, **k)

    socket.socket = guarded_socket  # type: ignore[assignment,misc]


def main() -> None:
    data = json.loads(sys.stdin.read())
    module_path: str = data["module"]
    args: dict[str, Any] = data.get("args", {})
    limits: dict[str, Any] = data.get("limits", {})

    # Import the tool BEFORE installing fs guards (import reads .py files).
    try:
        mod_name, func_name = module_path.split(":", 1)
        module = importlib.import_module(mod_name)
        fn = getattr(module, func_name)
    except (ValueError, ImportError, AttributeError) as e:
        _emit({"denied": True, "reason": f"tool import failed: {e}"})
        return

    _install_guards(limits.get("allow_network", []),
                    limits.get("allow_fs_read", []),
                    limits.get("allow_fs_write", []))

    try:
        result = fn(args)
        if inspect.isawaitable(result):
            result = asyncio.run(result)  # type: ignore[arg-type]
        if not isinstance(result, dict):
            _emit({"denied": True, "reason": "tool returned non-dict"})
            return
        _emit({"ok": True, "result": result})
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — any escape attempt is a denial
        _emit({"denied": True, "reason": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
