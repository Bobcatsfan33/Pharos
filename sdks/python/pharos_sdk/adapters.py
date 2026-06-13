"""Framework adapters for CrewAI and the Microsoft Agent Framework.

Thin structural wrappers (no framework dependency) that delegate to the shared
``govern_tool`` so they share one conformance contract with the TypeScript middlewares.
"""
from __future__ import annotations

from typing import Any, Callable, Dict

from .govern import Governor, govern_tool


def crewai_tool(governor: Governor, opts: Dict[str, Any], func: Callable[[Dict[str, Any]], Any]) -> Dict[str, Any]:
    """Return a CrewAI-style tool dict whose ``run`` is governed by Pharos."""
    return {
        "name": opts["tool_name"],
        "description": opts.get("description", f"Governed tool {opts['tool_name']}"),
        "run": govern_tool(governor, opts, func),
    }


def ms_agent_tool(governor: Governor, opts: Dict[str, Any], func: Callable[[Dict[str, Any]], Any]) -> Dict[str, Any]:
    """Return a Microsoft Agent Framework-style function tool, governed by Pharos."""
    return {
        "name": opts["tool_name"],
        "parameters": opts.get("parameters", {"type": "object", "properties": {}}),
        "invoke": govern_tool(governor, opts, func),
    }
