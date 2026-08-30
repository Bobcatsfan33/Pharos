"""Fast in-suite check of the trace-overhead benchmark (the full CI gate runs
`python -m tests.chaos.bench_overhead` with more iterations)."""
import pytest
from tests.chaos.bench_overhead import measure, within_budget


@pytest.mark.asyncio
async def test_trace_overhead_within_budget():
    bp, rp, overhead = await measure(iters=15, warmup=4, batch=15, attempts=3)
    assert within_budget(bp, rp, overhead), (
        f"overhead {overhead*100:.2f}% / {(rp-bp)*1e6:.0f}us/run over budget")
