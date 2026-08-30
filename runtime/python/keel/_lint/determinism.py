"""Nondeterminism lint gate (M1).

Replay is only airtight if every nondeterminism source flows through an L1 port. This
AST scanner fails CI when run-execution code introduces a *direct* nondeterminism
source — ``time.time()``, ``datetime.now()``, ``random.*``, ``uuid.uuid4()``,
``os.urandom()``, or a raw ``socket.socket()`` — instead of using the injected
``Clock`` / ``IdGen`` / ``Rng`` / ``ModelPort`` ports.

A small allowlist covers the places where these primitives legitimately live: the L1
ports themselves, the synthetic replay clock, and the sandbox/adversarial fixtures. An
individual line may opt out with a trailing ``# det-ok: <reason>`` comment, which is
recorded so waivers are auditable.

Run:  ``python -m keel._lint.determinism keel``  (exit 1 on any violation)
"""
from __future__ import annotations
import ast
import sys
from dataclasses import dataclass
from pathlib import Path

# call name -> the port a run-execution path should use instead
_DENY: dict[tuple[str, str], str] = {
    ("time", "time"): "Clock.monotonic()/now()",
    ("time", "monotonic"): "Clock.monotonic()",
    ("time", "perf_counter"): "Clock.monotonic()",
    ("datetime", "now"): "Clock.now()",
    ("datetime", "utcnow"): "Clock.now()",
    ("datetime", "today"): "Clock.now()",
    ("random", "random"): "Rng.random()",
    ("random", "choice"): "Rng.choice()",
    ("random", "randint"): "Rng",
    ("random", "uniform"): "Rng",
    ("random", "shuffle"): "Rng",
    ("uuid", "uuid1"): "IdGen.new()",
    ("uuid", "uuid4"): "IdGen.new()",
    ("os", "urandom"): "Rng / a recorded value",
    ("socket", "socket"): "ModelPort / the tool gateway",
}

# Files where these primitives are the implementation of the ports / fixtures.
_ALLOW = {
    "keel/substrate/ports.py",          # the ports themselves (SystemClock, UlidIdGen, SeededRng)
    "keel/services/replay.py",          # synthetic replay clock/ids for patched replay
    "keel/services/tools/sandbox_runner.py",  # the sandbox child's capability guards
    "keel/services/tools/_example_tools.py",  # adversarial fixtures (deliberately escape)
    "keel/_lint/determinism.py",        # this file
}

_OPT_OUT = "det-ok"


@dataclass(frozen=True)
class Violation:
    file: str
    line: int
    call: str
    suggestion: str


def _opted_out_lines(source: str) -> set[int]:
    return {i + 1 for i, line in enumerate(source.splitlines()) if _OPT_OUT in line}


def scan_source(rel_path: str, source: str) -> list[Violation]:
    if rel_path.replace("\\", "/") in _ALLOW:
        return []
    tree = ast.parse(source)
    opted = _opted_out_lines(source)
    out: list[Violation] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or not isinstance(func.value, ast.Name):
            continue
        key = (func.value.id, func.attr)
        if key in _DENY and node.lineno not in opted:
            out.append(Violation(rel_path, node.lineno, f"{key[0]}.{key[1]}()",
                                 _DENY[key]))
    return out


def scan_path(root: str) -> list[Violation]:
    root_path = Path(root)
    out: list[Violation] = []
    files = [root_path] if root_path.is_file() else sorted(root_path.rglob("*.py"))
    for f in files:
        rel = str(f).replace("\\", "/")
        # normalise to 'keel/...' so the allowlist matches regardless of cwd
        idx = rel.find("keel/")
        rel_norm = rel[idx:] if idx >= 0 else rel
        out.extend(scan_source(rel_norm, f.read_text()))
    return out


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    root = args[0] if args else "keel"
    violations = scan_path(root)
    for v in violations:
        print(f"{v.file}:{v.line}: nondeterminism `{v.call}` — use {v.suggestion} "
              f"(or add `# det-ok: <reason>`)", file=sys.stderr)
    if violations:
        print(f"\n{len(violations)} nondeterminism violation(s); replay would diverge.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
