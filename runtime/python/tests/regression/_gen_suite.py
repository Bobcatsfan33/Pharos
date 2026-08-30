"""Generate KEEL's own regression suite — KEEL dogfooding replay-as-a-test (M5).

Each bundle is a recorded run of a representative KIR graph, captured deterministically
(fixed clock + counter ids) so the committed artifact is reproducible and a reviewer can
diff a regeneration. Run from the repo root:

    python -m tests.regression._gen_suite

The committed bundles under ``tests/regression/suite/`` are the source of truth; the
GitHub Action (and ``keel regress run``) replays them byte-identically on every PR and
blocks the merge on any determinism or behavioural drift.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.regression import capture_bundle
from keel.services.evals import EvalCase, Assertion, AssertionType

# Recorded under the default price table so replay (which re-drives through the default
# handlers) reproduces cost byte-identically — the bundle is fully self-contained and
# needs no price config to replay in CI.
SUITE = Path(__file__).parent / "suite"


class _FixedClock:
    """Deterministic record-time clock: a fixed start advanced 1ms per call, so
    regenerating the suite produces byte-stable timestamps."""

    def __init__(self) -> None:
        self._t = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self._n = 0

    def now(self) -> datetime:
        self._n += 1
        return self._t + timedelta(milliseconds=self._n)

    def monotonic(self) -> float:
        return float(self._n)


class _CounterIdGen:
    def __init__(self) -> None:
        self._n = 0

    def new(self) -> str:
        self._n += 1
        return f"ev{self._n:08d}"


def _linear() -> Graph:
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP, config={"model": "mock:test"})
             for i in range(3)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(2)]
    return Graph(graph_id="pipeline-linear", nodes=nodes, edges=edges)


def _branch() -> Graph:
    # fan-out from root to two parallel nodes, fan-in to a join — exercises the
    # concurrent frontier under replay.
    nodes = [Node(id=n, type=NodeType.LLM_STEP, config={"model": "mock:test"})
             for n in ("root", "a", "b", "join")]
    edges = [Edge.model_validate(e) for e in (
        {"from": "root", "to": "a"}, {"from": "root", "to": "b"},
        {"from": "a", "to": "join"}, {"from": "b", "to": "join"})]
    return Graph(graph_id="pipeline-branch", nodes=nodes, edges=edges)


def _eval_graph() -> Graph:
    # Two-node chain whose final output the embedded eval case asserts on. Kept
    # registry-free (no output_schema) so the bundle replays standalone.
    nodes = [
        Node(id="ask", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
        Node(id="answer", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
    ]
    edges = [Edge.model_validate({"from": "ask", "to": "answer"})]
    return Graph(graph_id="pipeline-eval", nodes=nodes, edges=edges)


async def _capture(graph: Graph, *, reply: str, eval_case: EvalCase | None = None):
    runner = await Runner.open(in_memory=True, model=MockModelPort(reply=reply),
                               clock=_FixedClock(), ids=_CounterIdGen())
    rid = graph.graph_id
    await runner.run(graph, run_id=rid)
    events = await runner.read_events(rid)
    bundle = capture_bundle(bundle_id=graph.graph_id, run_id=rid, graph=graph,
                            events=events, blobs=runner.blobs, eval_case=eval_case)
    await runner.close()
    return bundle


async def main() -> None:
    SUITE.mkdir(parents=True, exist_ok=True)
    eval_case = EvalCase(
        case_id="pipeline-eval:answer-is-42",
        graph_id="pipeline-eval",
        recorded_run_id="pipeline-eval",
        assertions=[Assertion(type=AssertionType.EXACT, node_id="answer",
                              field="answer", expected="42")],
    )
    bundles = [
        await _capture(_linear(), reply='{"ok": true}'),
        await _capture(_branch(), reply='{"ok": true}'),
        await _capture(_eval_graph(), reply='{"answer": "42"}', eval_case=eval_case),
    ]
    for b in bundles:
        (SUITE / f"{b.bundle_id}.json").write_text(b.model_dump_json(indent=2))
        print(f"wrote {b.bundle_id}.json  ({len(b.events)} events, {len(b.blobs)} blobs"
              f"{', +eval' if b.eval_case else ''})")


if __name__ == "__main__":
    asyncio.run(main())
