"""JUnit XML for the regression suite (M5), so replay-as-a-test slots into any CI that
understands JUnit. A determinism-drift or behavioural-drift bundle is a hard failure;
a bundle whose eval case is merely flaky is reported as skipped, not failed."""
from __future__ import annotations

from typing import Any
from xml.sax.saxutils import escape, quoteattr


def to_junit(report: dict[str, Any]) -> str:
    findings = report.get("findings", [])
    failures = len(report.get("regressed", []))
    skipped = len(report.get("flaky", []))
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<testsuite name="keel-regression" tests="{len(findings)}" '
        f'failures="{failures}" skipped="{skipped}">',
    ]
    for f in findings:
        bid = escape(str(f["bundle_id"]))
        lines.append(f'  <testcase name="{bid}" classname="keel.regression">')
        if not f["replay_identical"]:
            msg = quoteattr(f"replay drift: {f['replay_detail']}")
            lines.append(f'    <failure message={msg}>byte-identity lost</failure>')
        elif f.get("eval_flaky"):
            lines.append(f'    <skipped message="flaky eval: '
                         f'{f.get("eval_passed")}/{f.get("eval_of")}"/>')
        elif f.get("eval_of") is not None and f.get("eval_passed") != f.get("eval_of"):
            msg = quoteattr(f"eval drift: {f.get('eval_detail', '')}")
            lines.append(f'    <failure message={msg}>assertion(s) failed</failure>')
        lines.append('  </testcase>')
    lines.append('</testsuite>')
    return "\n".join(lines)
