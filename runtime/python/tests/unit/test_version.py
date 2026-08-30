"""keel.__version__ must track the packaged version (pyproject.toml)."""
from importlib.metadata import version

import keel
import pharos_runtime


def test_dunder_version_matches_package_metadata():
    installed = version("pharos-runtime")
    assert pharos_runtime.__version__ == installed
    assert keel.__version__ == installed
