"""JUnit XML for the eval suite, so recorded-run regression tests slot into any CI
that understands JUnit. Flaky cases are reported as a distinct outcome rather than a
hard failure."""
from __future__ import annotations
from typing import Any
from xml.sax.saxutils import escape


def to_junit(report: dict[str, Any]) -> str:
    cases = report.get("cases", [])
    flaky = set(report.get("flaky", []))
    failures = int(report.get("failed", 0))
    skipped = len(flaky)
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<testsuite name="keel-evals" tests="{len(cases)}" '
        f'failures="{failures}" skipped="{skipped}">',
    ]
    for c in cases:
        cid = escape(str(c["case_id"]))
        passed, of = int(c["passed"]), int(c["of"])
        lines.append(f'  <testcase name="{cid}" classname="keel.evals">')
        if c["case_id"] in flaky:
            lines.append(f'    <skipped message="flaky: {passed}/{of} passes"/>')
        elif passed < of:
            lines.append(f'    <failure message="{passed}/{of} passes">'
                         'assertion(s) failed</failure>')
        lines.append('  </testcase>')
    lines.append('</testsuite>')
    return "\n".join(lines)
