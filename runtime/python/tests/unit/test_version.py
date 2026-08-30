"""keel.__version__ must track the packaged version (pyproject.toml)."""
from importlib.metadata import version

import keel


def test_dunder_version_matches_package_metadata():
    assert keel.__version__ == version("keel")
