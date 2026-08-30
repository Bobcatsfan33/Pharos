"""P4-1: the five assertion types, plus flake detection in run_suite."""
import json
import pytest
from pydantic import BaseModel

from keel.kir.schema import Graph, Node, NodeType
from keel.kir.schemas_registry import register_schema, clear
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.model.port import ModelRequest, ModelResponse
from keel.services.evals import (EvalRunner, EvalCase, Assertion, AssertionType)


class Summary(BaseModel):
    answer: str


@pytest.fixture(autouse=True)
def _schema():
    clear()
    register_schema(Summary)
    yield
    clear()


async def _record(reply: str, node_id: str = "n") -> Runner:
    runner = await Runner.open(in_memory=True, model=MockModelPort(reply=reply))
    g = Graph(graph_id="g", nodes=[Node(id=node_id, type=NodeType.LLM_STEP,
                                        config={"model": "mock:test"})], edges=[])
    await runner.run(g, run_id="rec")
    return runner


@pytest.mark.asyncio
async def test_exact_and_schema_and_field():
    runner = await _record('{"answer": "42"}')
    er = EvalRunner(runner.store, runner.blobs)
    case = EvalCase(case_id="c", graph_id="g", recorded_run_id="rec", assertions=[
        Assertion(type=AssertionType.SCHEMA, node_id="n", expected="ref:schemas/Summary"),
        Assertion(type=AssertionType.EXACT, node_id="n", field="answer", expected="42"),
        Assertion(type=AssertionType.NUMERIC_TOLERANCE, node_id="n", field="answer",
                  expected=42, tolerance=0.5),
    ])
    results = await er.run_case(case)
    await runner.close()
    assert all(r.passed for r in results), [r.detail for r in results]


@pytest.mark.asyncio
async def test_numeric_tolerance_fails_outside_band():
    runner = await _record('{"answer": "10"}')
    er = EvalRunner(runner.store, runner.blobs)
    case = EvalCase(case_id="c", graph_id="g", recorded_run_id="rec", assertions=[
        Assertion(type=AssertionType.NUMERIC_TOLERANCE, node_id="n", field="answer",
                  expected=42, tolerance=1.0)])
    r = (await er.run_case(case))[0]
    await runner.close()
    assert not r.passed


@pytest.mark.asyncio
async def test_semantic_similarity():
    runner = await _record("graph databases store edges and nodes")
    er = EvalRunner(runner.store, runner.blobs)
    case = EvalCase(case_id="c", graph_id="g", recorded_run_id="rec", assertions=[
        Assertion(type=AssertionType.SEMANTIC_SIMILARITY, node_id="n",
                  expected="graph databases store edges and nodes", tolerance=0.99)])
    r = (await er.run_case(case))[0]
    await runner.close()
    assert r.passed and r.score and r.score >= 0.99  # identical text -> ~1.0


@pytest.mark.asyncio
async def test_llm_judge_and_flake_detection():
    runner = await _record("the sky is blue")

    class FlakyJudge:
        def __init__(self): self.n = 0
        async def complete(self, req: ModelRequest) -> ModelResponse:
            self.n += 1
            verdict = {"pass": self.n % 2 == 1, "score": 0.5, "reason": "varies"}
            return ModelResponse(text=json.dumps(verdict), tokens_in=1, tokens_out=1,
                                 model=req.model)
        async def stream(self, req):  # pragma: no cover
            yield ""
        def count_tokens(self, t, m): return 1

    er = EvalRunner(runner.store, runner.blobs, judge=FlakyJudge())
    case = EvalCase(case_id="judged", graph_id="g", recorded_run_id="rec", assertions=[
        Assertion(type=AssertionType.LLM_JUDGE, node_id="n",
                  judge_model="anthropic:claude-haiku-4-5@2026-05",
                  rubric="Is this a factual statement?")])
    report = await er.run_suite([case], n_flake=4)
    await runner.close()
    # judge alternates pass/fail -> case is flagged flaky, not silently failed
    assert "judged" in report["flaky"]
