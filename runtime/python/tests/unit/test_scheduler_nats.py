"""P2-3: NATS JetStream scheduler enqueue/dequeue round-trip. Skipped unless
NATS_URL points at a reachable broker (the code is type-checked regardless)."""
import os

import pytest

pytest.importorskip("nats")
from keel.services.scheduler_nats import NatsScheduler  # noqa: E402

NATS_URL = os.environ.get("NATS_URL")
pytestmark = pytest.mark.skipif(not NATS_URL, reason="set NATS_URL to run NATS test")


@pytest.mark.asyncio
async def test_nats_enqueue_dequeue_roundtrip():
    sched = await NatsScheduler(NATS_URL, stream="KEEL_TEST",
                                subject="keel.test", durable="keel-test").connect()
    try:
        await sched.enqueue("run-xyz")
        assert await sched.dequeue() == "run-xyz"
    finally:
        await sched.close()
