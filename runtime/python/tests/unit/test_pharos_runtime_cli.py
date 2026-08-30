from __future__ import annotations

import pytest

from keel import cli as engine_cli
from pharos_runtime.adapters import AgentNode
from pharos_runtime.cli import main


def test_pharos_command_uses_product_name(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        main(["--help"])

    assert raised.value.code == 0
    assert capsys.readouterr().out.startswith("usage: pharos")


def test_branded_namespace_exposes_runtime_modules() -> None:
    assert AgentNode.__name__ == "AgentNode"


def test_pharos_runtime_storage_environment_precedes_legacy_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PHAROS_RUNTIME_DATA_DIR", "/pharos")
    monkeypatch.setenv("KEEL_DATA_DIR", "/legacy")

    assert engine_cli._default_db() == "/pharos/keel.db"
    assert engine_cli._default_blobs() == "/pharos/blobs"
