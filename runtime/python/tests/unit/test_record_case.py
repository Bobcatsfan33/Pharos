"""P4-2: record a recorded run into an eval case, run the suite, emit JUnit; flaky
cases are a distinct outcome from failures."""
import pytest
from pydantic import BaseModel

from keel.kir.schema import Graph, Node, NodeType
from keel.kir.schemas_registry import register_schema, clear
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.evals import EvalRunner, EvalCase, Assertion, AssertionType
from keel.services.evals.junit import to_junit


class Out(BaseModel):
    answer: str


@pytest.fixture(autouse=True)
def _schema():
    clear()
    register_schema(Out)
    yield
    clear()


@pytest.mark.asyncio
async def test_record_then_run_suite_passes():
    runner = await Runner.open(in_memory=True, model=MockModelPort(reply='{"answer": "ok"}'))
    g = Graph(graph_id="g", nodes=[Node(id="n", type=NodeType.LLM_STEP,
              output_schema="ref:schemas/Out", config={"model": "mock:test"})], edges=[])
    await runner.run(g, run_id="rec")

    case = EvalCase(case_id="g:rec", graph_id="g", recorded_run_id="rec", assertions=[
        Assertion(type=AssertionType.SCHEMA, node_id="n", expected="ref:schemas/Out")])
    report = await EvalRunner(runner.store, runner.blobs).run_suite([case], n_flake=3)
    await runner.close()
    assert report["passed"] == 1 and report["total"] == 1 and not report["flaky"]


def test_junit_distinguishes_pass_fail_flaky():
    report = {
        "cases": [{"case_id": "ok", "passed": 3, "of": 3},
                  {"case_id": "bad", "passed": 0, "of": 3},
                  {"case_id": "flk", "passed": 1, "of": 3}],
        "passed": 1, "failed": 1, "flaky": ["flk"], "total": 3,
    }
    xml = to_junit(report)
    assert 'tests="3"' in xml and 'failures="1"' in xml and 'skipped="1"' in xml
    assert '<testcase name="bad"' in xml and "<failure" in xml
    assert '<testcase name="flk"' in xml and "<skipped" in xml
    assert '<testcase name="ok"' in xml
