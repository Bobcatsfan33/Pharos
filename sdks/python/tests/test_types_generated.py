"""The committed wire types are exactly what the generator renders from the JSON Schema."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import get_args

ROOT = Path(__file__).resolve().parents[3]


def _load_generator():
    path = ROOT / "sdks" / "python" / "scripts" / "gen_types.py"
    spec = importlib.util.spec_from_file_location("gen_types", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_types_py_matches_the_published_schema():
    gen = _load_generator()
    assert gen.main(["--check"]) == 0, "run python3 sdks/python/scripts/gen_types.py"


def test_validation_enums_come_from_the_generated_types():
    from pharos_sdk import types, validation

    schema = json.loads((ROOT / "packages" / "pdp-spec" / "schema" / "pdp-v1.schema.json").read_text())
    assert list(get_args(types.OversightMode)) == schema["$defs"]["OversightMode"]["enum"]
    assert list(get_args(types.Reversibility)) == schema["$defs"]["Reversibility"]["enum"]
    assert validation.OVERSIGHT_MODES == tuple(get_args(types.OversightMode))
    assert validation.REVERSIBILITY == tuple(get_args(types.Reversibility))
    assert sys.version_info >= (3, 9)
