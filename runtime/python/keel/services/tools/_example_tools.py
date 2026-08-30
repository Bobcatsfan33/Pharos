"""Reference tool implementations used by the sandbox red-team test (P4-3). Each
takes a validated args dict and returns a dict. The 'escape' tools deliberately
attempt undeclared access so the sandbox can prove it blocks them."""
from __future__ import annotations
from typing import Any


def echo_len(args: dict[str, Any]) -> dict[str, Any]:
    """Well-behaved: no fs/network access."""
    return {"n": len(str(args.get("query", "")))}


def try_network(args: dict[str, Any]) -> dict[str, Any]:
    """Attempts an undeclared network socket — must be blocked."""
    import socket
    socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    return {"n": -1}


def try_fs(args: dict[str, Any]) -> dict[str, Any]:
    """Attempts to read an undeclared file — must be blocked."""
    with open("/etc/hosts") as f:
        return {"n": len(f.read())}


def bad_output(args: dict[str, Any]) -> dict[str, Any]:
    """Returns output that violates the declared output schema."""
    return {"unexpected": "field"}
