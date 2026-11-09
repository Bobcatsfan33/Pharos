"""``pharos`` — the command line shipped with the ``getpharos`` distribution.

Why this entry point does two different things
----------------------------------------------
``pharos verify`` is implemented here, in Python, with no dependency on Pharos or Node:
verifying a bundle is hashing, signature checks and a chain walk over public keys, which
``pharos_sdk.verify`` reimplements from the documented procedure.  That is exactly the
kind of independent re-implementation the evidence model wants to exist.

Every other command (``init``, ``demo``, ``log``, ``export``, ``run``, ``serve``) *seals*
records, and sealing is the trust core.  ADR 0006 §2–3 keeps one trust core: the
TypeScript packages, bundled as ``@getpharos/cli``.  A Python re-implementation of sealing
would be a second signer with its own key handling, canonicalization and storage to audit,
drift between, and keep in lock-step — so this entry point delegates those commands to the
Node CLI via ``npx @getpharos/cli`` instead of pretending to be it.  When Node is not
installed it says so and exits ``EX_UNAVAILABLE`` (69) rather than half-working.

Exit codes for ``pharos verify``: ``0`` PASS, ``1`` FAIL, ``2`` the chain and every
verifiable anchor PASSED but something was skipped (RFC 3161 anchors are not verified in
Python — see ``pharos_sdk.verify``).  Delegated commands return the Node CLI's exit code.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from typing import Any, Dict, List, Optional, Sequence

from .verify import verify_bundle

PROG = "pharos"
NPX_PACKAGE = "@getpharos/cli"
NODE_COMMANDS = ("init", "demo", "log", "export", "run", "serve")
NODE_COMMAND_SUMMARIES = {
    "init": "write pharos.yaml and start embedded storage here",
    "demo": "three verdicts, a verified chain, an evidence bundle",
    "log": "read the sealed chain",
    "export": "write the evidence bundle",
    "run": "govern a shell command: verdict, sealed record, then execute (or not)",
    "serve": "start the Pharos API over embedded storage",
}
NODE_MISSING_MESSAGE = (
    "pharos {cmd} needs Node >= 22.13 (install from https://nodejs.org) — the embedded "
    "control plane is the Node CLI; `pharos verify` works with Python alone."
)

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_SKIPPED = 2
EXIT_USAGE = 2
EX_UNAVAILABLE = 69

OK_MARK = "✔"  # ✔
FAIL_MARK = "✘"  # ✘
SKIP_MARK = "!"


def package_version() -> str:
    """The installed ``getpharos`` version, or ``dev`` when running from a checkout."""
    try:
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:  # pragma: no cover - Python < 3.8
        return "dev"
    try:
        return version("getpharos")
    except PackageNotFoundError:
        return "dev"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "Real-time policy verdicts for AI agents, with a sealed, hash-chained record of "
            "every decision."
        ),
        epilog=(
            "verify runs in pure Python. The other commands are the embedded control plane "
            "and delegate to the Node CLI (npx %s)." % NPX_PACKAGE
        ),
    )
    parser.add_argument("--version", action="store_true", help="print the getpharos version")
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    verify = sub.add_parser(
        "verify",
        help="verify an evidence bundle offline (pure Python); exit 0/1/2",
        description=(
            "Verify every hash, signature and chain link in an evidence bundle, then its "
            "local trusted-time anchors, with public keys only — no Pharos, no Node. "
            "RFC 3161 anchors are reported but not verified here. "
            "Exit code 0 = PASS, 1 = FAIL, 2 = PASS with skipped checks."
        ),
    )
    verify.add_argument("bundle", help="path to the evidence bundle JSON")
    verify.add_argument("--json", action="store_true", help="print the report as JSON")

    for name in NODE_COMMANDS:
        node = sub.add_parser(name, help=NODE_COMMAND_SUMMARIES[name] + " (Node CLI)", add_help=False)
        node.add_argument("args", nargs=argparse.REMAINDER)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    # Delegated commands are passed through untouched (including their --help and `--`),
    # so argparse never sees options that belong to the Node CLI.
    if args and args[0] in NODE_COMMANDS:
        return delegate_to_node(args[0], args[1:])

    parser = build_parser()
    if not args:
        parser.print_usage(sys.stderr)
        return EXIT_USAGE
    try:
        parsed = parser.parse_args(args)
    except SystemExit as exc:  # argparse already printed usage/help
        return int(exc.code or 0)
    if parsed.version:
        print(package_version())
        return 0
    if parsed.command == "verify":
        return verify_command(parsed.bundle, as_json=parsed.json)
    parser.print_usage(sys.stderr)
    return EXIT_USAGE


def delegate_to_node(command: str, rest: Sequence[str]) -> int:
    """Hand a sealing command to ``npx @getpharos/cli``; explain and exit 69 without Node."""
    npx = shutil.which("npx")
    if npx is None:
        print(NODE_MISSING_MESSAGE.format(cmd=command), file=sys.stderr)
        return EX_UNAVAILABLE
    argv = ["npx", "-y", NPX_PACKAGE, command, *rest]
    os.execvp(npx, argv)
    return EX_UNAVAILABLE  # pragma: no cover - execvp does not return


def verify_command(path: str, as_json: bool = False) -> int:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            bundle = json.load(handle)
    except (OSError, ValueError) as exc:
        print("error: cannot read bundle %s: %s" % (path, exc), file=sys.stderr)
        return EXIT_FAIL
    try:
        report = verify_bundle(bundle)
    except ImportError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_FAIL
    except ValueError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_FAIL

    if as_json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        for line in render_report(path, report):
            print(line)
    return exit_code_for(report)


def exit_code_for(report: Dict[str, Any]) -> int:
    if not report["ok"]:
        return EXIT_FAIL
    if report["skipped"]:
        return EXIT_SKIPPED
    return EXIT_PASS


def _mark(ok: Optional[bool]) -> str:
    if ok is None:
        return SKIP_MARK
    return OK_MARK if ok else FAIL_MARK


def _short_hash(value: Any, n: int = 12) -> str:
    return str(value)[:n] + "…"


def render_report(source: str, report: Dict[str, Any]) -> List[str]:
    """The same lines the Node CLI prints (minus colour), plus a `skipped` line when needed."""
    chain = report["chain"]
    lines = ["Verifying %s — public keys only, no Pharos required" % source, ""]
    for record in chain["records"]:
        checks = record["checks"]
        line = "seq %3s  hash %s  sig %s  link %s" % (
            record["sequence"],
            "ok " if checks["content_hash_matches"] else "BAD",
            "ok " if checks["signature_valid"] else "BAD",
            "ok " if checks["chain_link_valid"] else "BAD",
        )
        lines.append("  %s %s" % (_mark(record["ok"]), line))
    lines.append("")
    if chain["ok"]:
        lines.append("%s chain: PASS — %d records, admissible" % (OK_MARK, chain["records_checked"]))
    else:
        lines.append("%s chain: FAIL — %s" % (FAIL_MARK, "; ".join(chain["errors"])))
    if report["anchors"]:
        for entry in report["anchors"]:
            anchor = entry["anchor"]
            line = "anchor [%s] %s @ %s%s%s" % (
                entry["kind"],
                _short_hash(anchor.get("hash", "")),
                anchor.get("time"),
                "  (head)" if entry["covers_head"] else "",
                "  skipped" if entry["ok"] is None else "",
            )
            lines.append("  %s %s" % (_mark(entry["ok"]), line))
        verified_head = any(e["ok"] is True and e["covers_head"] for e in report["anchors"])
        if not report["anchors_ok"]:
            lines.append("%s anchors: FAIL" % FAIL_MARK)
        elif verified_head:
            lines.append("%s anchors: PASS — the head existed before the stamped time" % OK_MARK)
        else:
            # Only unverified (rfc3161) anchors cover the head: say nothing we have not proven.
            lines.append("%s anchors: NOT VERIFIED — rfc3161 token(s) skipped" % SKIP_MARK)
    for skipped in report["skipped"]:
        lines.append("%s skipped: %s" % (SKIP_MARK, skipped))
    lines.append("")
    return lines


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
