"""M3: the signature crash/resume demo is a CI gate — cost after resume equals the
clean-run cost (never re-billed), and only the remaining steps execute on resume."""
import pytest

from examples.crash_resume_demo import _clean_cost, _crash_then_resume, main


@pytest.mark.asyncio
async def test_cost_of_resume_equals_clean_run():
    clean = await _clean_cost()
    resumed_cost, resume_calls = await _crash_then_resume()
    assert clean > 0, "the demo must make billed calls for the assertion to mean anything"
    assert abs(resumed_cost - clean) < 1e-9, (
        f"resume re-billed: ${resumed_cost:.6f} != clean ${clean:.6f}")
    # 4-step pipeline; 'research' committed before the crash -> only 3 run on resume
    assert resume_calls == 3


@pytest.mark.asyncio
async def test_demo_main_passes():
    assert await main() == 0
