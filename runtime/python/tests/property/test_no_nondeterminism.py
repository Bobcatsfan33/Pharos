"""M1: the nondeterminism lint gate. The whole keel/ tree is clean, a planted
violation is caught, and the `# det-ok` escape works."""
from keel._lint.determinism import scan_path, scan_source


def test_repo_has_no_unported_nondeterminism():
    violations = scan_path("keel")
    assert violations == [], "\n".join(f"{v.file}:{v.line} {v.call}" for v in violations)


def test_planted_violation_is_caught():
    src = "import time\n\ndef handler():\n    return time.time()\n"
    out = scan_source("keel/services/nodes.py", src)
    assert len(out) == 1 and out[0].call == "time.time()"


def test_each_denied_source_is_caught():
    cases = {
        "datetime.now()": "import datetime\nx = datetime.now()\n",
        "random.random()": "import random\nx = random.random()\n",
        "uuid.uuid4()": "import uuid\nx = uuid.uuid4()\n",
        "socket.socket()": "import socket\nx = socket.socket()\n",
    }
    for call, src in cases.items():
        out = scan_source("keel/executor/engine.py", src)
        assert len(out) == 1 and out[0].call == call, call


def test_det_ok_escape_suppresses():
    src = "import time\nx = time.time()  # det-ok: benchmark timing only\n"
    assert scan_source("keel/executor/engine.py", src) == []


def test_allowlisted_files_are_skipped():
    src = "import time\nx = time.time()\n"
    assert scan_source("keel/substrate/ports.py", src) == []
