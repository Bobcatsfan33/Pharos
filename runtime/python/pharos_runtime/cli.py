"""Branded command-line entrypoint for the Pharos durable runtime."""

from __future__ import annotations

from typing import Optional

from keel.cli import main as keel_main


def main(argv: Optional[list[str]] = None) -> int:
    """Run the durable engine through the canonical ``pharos`` command."""
    return keel_main(argv, prog="pharos")


if __name__ == "__main__":
    raise SystemExit(main())
