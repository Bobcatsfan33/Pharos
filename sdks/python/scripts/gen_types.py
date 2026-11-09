"""Render pharos_sdk/types.py from the published PDP JSON Schema.

The wire contract has one source, packages/pdp-spec/src/schema.ts, published as
packages/pdp-spec/schema/pdp-v1.schema.json. This script turns that document into Python
``Literal`` and ``TypedDict`` declarations so the SDK's types cannot drift from the contract.
``tests/test_types_generated.py`` regenerates and diffs the committed file.

Run from the repository root:  python3 sdks/python/scripts/gen_types.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = ROOT / "packages" / "pdp-spec" / "schema" / "pdp-v1.schema.json"
TARGET = ROOT / "sdks" / "python" / "pharos_sdk" / "types.py"


def _py_type(node: dict) -> str:
    if "$ref" in node:
        return node["$ref"].rsplit("/", 1)[-1]
    if "anyOf" in node:
        members = node["anyOf"]
        if all("const" in m for m in members):
            return "Literal[" + ", ".join(repr(m["const"]) for m in members) + "]"
        if all("enum" in m or "const" in m for m in members):
            values = [v for m in members for v in m.get("enum", [m.get("const")])]
            return "Literal[" + ", ".join(repr(v) for v in values) + "]"
        # Union[...] rather than X | Y: the SDK supports Python 3.9, where module-level
        # unions of typing special forms do not evaluate.
        return "Union[" + ", ".join(_py_type(n) for n in members) + "]"
    if "enum" in node:
        return "Literal[" + ", ".join(repr(v) for v in node["enum"]) + "]"
    if "const" in node:
        return f"Literal[{node['const']!r}]"
    kind = node.get("type")
    if isinstance(kind, list):
        return "Union[" + ", ".join(_py_type({**node, "type": k}) for k in kind) + "]"
    if kind == "string":
        return "str"
    if kind == "number":
        return "float"
    if kind == "integer":
        return "int"
    if kind == "boolean":
        return "bool"
    if kind == "null":
        return "None"
    if kind == "array":
        return f"list[{_py_type(node.get('items', {}))}]"
    if kind == "object":
        # Inline objects stay loose; every named object is its own TypedDict.
        return "dict[str, Any]"
    return "Any"


def _render(schema: dict) -> str:
    defs: dict = schema["$defs"]
    digest = hashlib.sha256(SCHEMA.read_bytes()).hexdigest()
    out: list[str] = [
        '"""Wire types for the Pharos PDP contract.',
        "",
        "Generated from packages/pdp-spec/schema/pdp-v1.schema.json by",
        "sdks/python/scripts/gen_types.py. Do not edit; regenerate.",
        f"Contract version {schema['version']}, schema sha256 {digest}.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from typing import Any, Literal, TypedDict, Union",
        "",
        f"PDP_SPEC_VERSION = {schema['version']!r}",
        f"SCHEMA_SHA256 = {digest!r}",
        "",
    ]
    for name, node in defs.items():
        if node.get("type") == "object" and "properties" in node:
            required = set(node.get("required", []))
            props = node["properties"]
            req = {k: v for k, v in props.items() if k in required}
            opt = {k: v for k, v in props.items() if k not in required}
            # Required and optional keys cannot share one total= setting; optional keys go
            # on a base class with total=False.
            base = "TypedDict"
            if opt:
                out.append(f"class _{name}Optional(TypedDict, total=False):")
                for key, sub in opt.items():
                    out.append(f"    {key}: {_py_type(sub)}")
                out.append("")
                out.append("")
                base = f"_{name}Optional"
            out.append(f"class {name}({base}):")
            doc = node.get("description")
            if doc:
                out.append(f'    """{doc}"""')
            if not req:
                out.append("    pass")
            for key, sub in req.items():
                out.append(f"    {key}: {_py_type(sub)}")
            out.append("")
            out.append("")
            continue
        out.append(f"{name} = {_py_type(node)}")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def main(argv: list[str]) -> int:
    rendered = _render(json.loads(SCHEMA.read_text()))
    if "--check" in argv:
        current = TARGET.read_text() if TARGET.exists() else ""
        if current != rendered:
            sys.stderr.write(f"{TARGET} is stale; run python3 {Path(__file__).relative_to(ROOT)}\n")
            return 1
        return 0
    TARGET.write_text(rendered)
    print(f"wrote {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
