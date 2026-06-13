"""Shared conformance contract for the Python framework adapters (CrewAI, MS Agent).

Mirrors the TypeScript middleware conformance: allow runs the tool, block raises,
escalate+approve runs exactly once, escalate+reject raises, double-resume runs at most once.
"""
import pytest

from pharos_sdk import crewai_tool, ms_agent_tool, PharosBlockedError


class FakeGovernor:
    def __init__(self, decision, resolution_status="approved"):
        self.decision = decision
        self.resolution_status = resolution_status
        self._claimed = set()

    def submit(self, **kwargs):
        return {
            "verdict": {"decision": self.decision, "ruleCitations": [{"ruleId": "t", "pack": "t"}]},
            "record": {"content": {"id": "r1", "sequence": 0}},
            "escalation": {"id": "e1", "status": "pending"} if self.decision == "escalate" else None,
        }

    def await_resolution(self, tenant_id, escalation_id, **kwargs):
        return {"id": escalation_id, "status": self.resolution_status,
                "resolution": {"decision": "approve", "rationale": "ok", "modifiedAction": None}}

    def claim(self, tenant_id, escalation_id):
        first = escalation_id not in self._claimed
        self._claimed.add(escalation_id)
        return {"claimed": first, "status": self.resolution_status,
                "resolution": {"decision": "approve", "rationale": "ok", "modifiedAction": None}}


OPTS = {"tenant_id": "t", "agent_id": "a", "tool_name": "pay"}


def _invoker(framework, governor, tool):
    if framework == "crewai":
        return crewai_tool(governor, OPTS, tool)["run"]
    return ms_agent_tool(governor, OPTS, tool)["invoke"]


@pytest.mark.parametrize("framework", ["crewai", "ms_agent"])
def test_allow_runs_tool(framework):
    runs = {"n": 0}
    def tool(args):
        runs["n"] += 1
        return "done"
    invoke = _invoker(framework, FakeGovernor("allow"), tool)
    assert invoke({"amount": 1}) == "done"
    assert runs["n"] == 1


@pytest.mark.parametrize("framework", ["crewai", "ms_agent"])
def test_block_raises_and_skips(framework):
    runs = {"n": 0}
    def tool(args):
        runs["n"] += 1
    invoke = _invoker(framework, FakeGovernor("block"), tool)
    with pytest.raises(PharosBlockedError):
        invoke({"amount": 1})
    assert runs["n"] == 0


@pytest.mark.parametrize("framework", ["crewai", "ms_agent"])
def test_escalate_approve_runs_once(framework):
    runs = {"n": 0}
    def tool(args):
        runs["n"] += 1
        return "done"
    invoke = _invoker(framework, FakeGovernor("escalate", "approved"), tool)
    assert invoke({"amount": 1}) == "done"
    assert runs["n"] == 1


@pytest.mark.parametrize("framework", ["crewai", "ms_agent"])
def test_escalate_reject_skips(framework):
    runs = {"n": 0}
    def tool(args):
        runs["n"] += 1
    invoke = _invoker(framework, FakeGovernor("escalate", "rejected"), tool)
    with pytest.raises(PharosBlockedError):
        invoke({"amount": 1})
    assert runs["n"] == 0


@pytest.mark.parametrize("framework", ["crewai", "ms_agent"])
def test_double_resume_runs_at_most_once(framework):
    runs = {"n": 0}
    gov = FakeGovernor("escalate", "approved")
    def tool(args):
        runs["n"] += 1
        return "done"
    invoke = _invoker(framework, gov, tool)
    assert invoke({"amount": 1}) == "done"
    # Second invocation shares escalation e1; the claim is already taken.
    with pytest.raises(PharosBlockedError):
        invoke({"amount": 1})
    assert runs["n"] == 1
