"""In-suite check of the viewer render budget (full gate:
`python -m tests.chaos.bench_viewer`)."""
import pytest

pytest.importorskip("fastapi")
from tests.chaos.bench_viewer import measure, RENDER_BUDGET_S  # noqa: E402


@pytest.mark.asyncio
async def test_viewer_renders_10k_events_under_budget(tmp_path):
    n_events, elapsed = await measure(nodes=1800, root=str(tmp_path))
    assert n_events >= 8000, f"expected a large run, got {n_events} events"
    assert elapsed < RENDER_BUDGET_S, f"{n_events} events rendered in {elapsed:.2f}s"
