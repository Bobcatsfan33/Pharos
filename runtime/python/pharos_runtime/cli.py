"""Branded command-line entrypoint for the Pharos durable runtime."""

from __future__ import annotations

from typing import Optional

from keel.cli import main as keel_main


def main(argv: Optional[list[str]] = None) -> int:
    """Run the durable engine through the ``pharos-runtime`` command.

    The bare ``pharos`` name belongs to the control-plane CLI (ADR 0006 §3).
    """
    return keel_main(argv, prog="pharos-runtime")


if __name__ == "__main__":
    raise SystemExit(main())
