"""Pharos Runtime public package.

The durable engine currently lives in the ``keel`` implementation namespace so existing
integrations keep working. New installations and command-line usage should use the Pharos
Runtime name.
"""

from pathlib import Path

from keel import __version__

# Expose the implementation modules through the branded namespace without copying them.
# The legacy ``keel`` namespace remains the canonical on-disk location for compatibility.
_implementation = Path(__file__).resolve().parent.parent / "keel"
__path__.append(str(_implementation))

__all__ = ["__version__"]
