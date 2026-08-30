"""M6: a bounded multi-worker soak runs in CI as a smoke; the full 24h operational soak
is the same harness with KEEL_SOAK_DURATION_S set (documented in soak.py)."""
import pytest

from tests.chaos.soak import run_soak
from bench.latency import measure as latency_measure, percentile, P99_CEILING_S


@pytest.mark.asyncio
async def test_soak_smoke_is_clean():
    # Small but adversarial: many crashes (committed-prefix and in-flight) across a few
    # batches and a worker pool. Asserts liveness, sound logs, commit-once, zero re-bill.
    report = await run_soak(workers=6, runs=24, nodes=5, crash_prob=0.5, seed=0,
                            batches=3)
    assert report.ok, report.summary()
    assert report.rebills == 0, f"recorded model calls were re-billed: {report.summary()}"
    assert report.crashes_prefix + report.crashes_inflight > 0, "no crashes injected"
    assert report.total_runs == 24 * 3


@pytest.mark.asyncio
async def test_soak_is_deterministic_across_seeds():
    for seed in (1, 2, 3):
        report = await run_soak(workers=8, runs=20, nodes=4, crash_prob=0.6, seed=seed,
                                batches=2)
        assert report.ok, f"seed {seed}: {report.summary()}"
        assert report.rebills == 0


def test_percentile_helper():
    xs = list(range(1, 101))  # 1..100, sorted
    assert percentile(xs, 50) == 50
    assert percentile(xs, 95) == 95
    assert percentile(xs, 99) == 99
    assert percentile([], 50) == 0.0


@pytest.mark.asyncio
async def test_latency_percentiles_are_ordered_and_bounded():
    report = await latency_measure(iters=60, warmup=10, nodes=6)
    assert report.p50_s <= report.p95_s <= report.p99_s
    assert report.p99_s < P99_CEILING_S, report.summary()
    assert report.mean_s > 0
