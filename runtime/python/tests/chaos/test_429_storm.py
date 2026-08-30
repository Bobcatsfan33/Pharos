"""P3-3: under a 429 storm, runs degrade rather than fail — the executor's per-node
retry/backoff (fed by the ModelError->RetryableError mapping) absorbs the storm — and
the rate limiter admits interactive work ahead of batch work."""
import asyncio
import pytest

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.substrate.ports import SystemClock
from keel.services.runner import Runner
from keel.services.model.port import ModelRequest, ModelResponse, ModelError
from keel.services.model.ratelimit import RateLimitedPort, TokenBucket, Priority


class StormyPort:
    """Returns 429 for the first `storm` calls, then succeeds — a clearing storm."""

    def __init__(self, storm: int) -> None:
        self._left = storm
        self.calls = 0

    async def complete(self, req: ModelRequest) -> ModelResponse:
        self.calls += 1
        if self._left > 0:
            self._left -= 1
            raise ModelError("rate_limit", "429 slow down", retry_after=0.0)
        return ModelResponse(text='{"ok": true}', tokens_in=5, tokens_out=2, model=req.model)

    async def stream(self, req: ModelRequest):  # pragma: no cover
        yield '{"ok": true}'

    def count_tokens(self, text: str, model: str) -> int:
        return 1


def _chain(n: int) -> Graph:
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP,
                  config={"model": "mock:test"},
                  retry={"max": 8, "backoff": "none"}) for i in range(n)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(n - 1)]
    return Graph(graph_id="storm", nodes=nodes, edges=edges)


@pytest.mark.asyncio
async def test_429_storm_no_failed_runs():
    # A burst of 429s; with retry.max=8 (per node) the storm clears within budget and
    # every run completes — zero failed runs.
    model = StormyPort(storm=6)
    runner = await Runner.open(in_memory=True, model=model)
    final = await runner.run(_chain(5), run_id="s1")
    await runner.close()
    assert final.status == "completed"
    assert all(r.status == "completed" for r in final.steps.values())


@pytest.mark.asyncio
async def test_token_bucket_paces_and_refills():
    clock = _Clock()
    bucket = TokenBucket(rate_per_s=5.0, capacity=2.0, clock=clock)
    assert bucket.try_take() and bucket.try_take()  # capacity
    assert not bucket.try_take()                    # empty
    clock.t += 0.2                                  # 0.2s * 5/s = 1 token
    assert bucket.try_take()
    assert not bucket.try_take()


@pytest.mark.asyncio
async def test_interactive_preempts_batch():
    order: list[str] = []

    class Recorder:
        async def complete(self, req: ModelRequest) -> ModelResponse:
            order.append(req.model)
            return ModelResponse(text="{}", tokens_in=1, tokens_out=1, model=req.model)

        async def stream(self, req):  # pragma: no cover
            yield ""

        def count_tokens(self, t, m):  # noqa: ANN001
            return 1

    clock = _Clock()
    # rate 0 + start empty so admission is purely manual via bucket.add().
    port = RateLimitedPort(Recorder(), rate_per_s=0.0, capacity=8.0, clock=clock,
                           poll_s=0.001)
    port._bucket._tokens = 0.0

    async def call(model: str, prio: Priority) -> None:
        await port.complete(ModelRequest(model=model, messages=[], max_tokens=1), prio)

    batch = asyncio.create_task(call("batch", Priority.BATCH))
    await asyncio.sleep(0.02)  # batch is now waiting
    inter = asyncio.create_task(call("interactive", Priority.INTERACTIVE))
    await asyncio.sleep(0.02)  # interactive now also waiting (higher priority)
    port._bucket.add(2.0)      # free two tokens
    await asyncio.gather(batch, inter)
    assert order[0] == "interactive", order  # interactive admitted first


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self):  # pragma: no cover
        return SystemClock().now()

    def monotonic(self) -> float:
        return self.t
