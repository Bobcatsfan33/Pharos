"""M5: replay-as-a-test. The committed dogfood suite replays byte-identically; a
mutated bundle is caught as a regression (determinism drift and behavioural drift)."""
from pathlib import Path

import pytest

from keel.services.regression import (RegressionBundle, capture_bundle, check_bundle,
                                       run_suite)
from keel.services.regression_junit import to_junit
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.kir.schema import Graph, Node, Edge, NodeType

SUITE = Path(__file__).resolve().parents[1] / "regression" / "suite"


def _load_suite() -> list[RegressionBundle]:
    return [RegressionBundle.model_validate_json(f.read_text())
            for f in sorted(SUITE.glob("*.json"))]


@pytest.mark.asyncio
async def test_dogfood_suite_replays_byte_identical():
    bundles = _load_suite()
    assert len(bundles) >= 3, "expected the committed dogfood suite"
    report = await run_suite(bundles, n_flake=2)
    assert report["regressed"] == [], f"committed suite regressed: {report['regressed']}"
    assert report["passed"] == report["total"]


@pytest.mark.asyncio
async def test_eval_bundle_present_and_passes():
    bundles = {b.bundle_id: b for b in _load_suite()}
    assert "pipeline-eval" in bundles
    finding = await check_bundle(bundles["pipeline-eval"], n_flake=2)
    assert finding.replay_identical
    assert finding.eval_of and finding.eval_passed == finding.eval_of
    assert not finding.regressed


@pytest.mark.asyncio
async def test_determinism_drift_is_caught():
    # Corrupt one recorded event's payload ref -> replay must diverge -> regressed.
    bundle = {b.bundle_id: b for b in _load_suite()}["pipeline-linear"]
    poisoned = bundle.model_dump()
    # flip a byte in the first llm.response event's cost so the log no longer matches
    for e in poisoned["events"]:
        if e["type"] == "llm.response":
            e["cost_usd"] = 999.0
            break
    finding = await check_bundle(RegressionBundle.model_validate(poisoned), n_flake=1)
    assert not finding.replay_identical
    assert finding.regressed


@pytest.mark.asyncio
async def test_behavioural_drift_is_caught():
    # An eval case whose expectation no longer matches the recorded output -> regressed,
    # even though replay is byte-identical.
    bundle = {b.bundle_id: b for b in _load_suite()}["pipeline-eval"]
    d = bundle.model_dump()
    d["eval_case"]["assertions"][0]["expected"] = "NOT-42"
    finding = await check_bundle(RegressionBundle.model_validate(d), n_flake=2)
    assert finding.replay_identical          # determinism intact
    assert finding.eval_passed == 0          # behaviour drifted
    assert finding.regressed


@pytest.mark.asyncio
async def test_capture_roundtrip_is_self_contained():
    # Capture a fresh run, serialize, reload, and check — the bundle carries its blobs.
    runner = await Runner.open(in_memory=True, model=MockModelPort())
    nodes = [Node(id="a", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
             Node(id="b", type=NodeType.LLM_STEP, config={"model": "mock:test"})]
    graph = Graph(graph_id="rt", nodes=nodes,
                  edges=[Edge.model_validate({"from": "a", "to": "b"})])
    await runner.run(graph, run_id="rt")
    events = await runner.read_events("rt")
    bundle = capture_bundle(bundle_id="rt", run_id="rt", graph=graph, events=events,
                            blobs=runner.blobs)
    await runner.close()
    reloaded = RegressionBundle.model_validate_json(bundle.model_dump_json())
    assert reloaded.blobs  # blobs were inlined
    finding = await check_bundle(reloaded, n_flake=1)
    assert finding.replay_identical and not finding.regressed


def test_junit_marks_failures_and_skips():
    report = {
        "total": 2, "passed": 1, "regressed": ["bad"], "flaky": ["wobble"],
        "findings": [
            {"bundle_id": "bad", "replay_identical": False, "replay_detail": "event #3",
             "eval_of": None, "eval_passed": None, "eval_flaky": False},
            {"bundle_id": "wobble", "replay_identical": True, "replay_detail": "",
             "eval_of": 3, "eval_passed": 1, "eval_flaky": True},
        ],
    }
    xml = to_junit(report)
    assert 'failures="1"' in xml and 'skipped="1"' in xml
    assert "byte-identity lost" in xml and "flaky eval" in xml
