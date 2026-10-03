"""NATS JetStream scheduler (keel[nats]).

Implements the ``Scheduler`` protocol over a JetStream stream so run ids survive a
broker restart and are delivered at-least-once across a multi-node worker pool.
Idempotency is the lease's job (only one worker advances a run); this layer only has
to deliver. Requires keel[nats].
"""
from __future__ import annotations
from typing import Any, Optional

DEFAULT_SUBJECT = "keel.runs"
DEFAULT_STREAM = "KEEL_RUNS"
DEFAULT_DURABLE = "keel-workers"


class NatsScheduler:
    def __init__(self, url: str = "nats://localhost:4222", *,
                 subject: str = DEFAULT_SUBJECT, stream: str = DEFAULT_STREAM,
                 durable: str = DEFAULT_DURABLE) -> None:
        self._url = url
        self._subject = subject
        self._stream = stream
        self._durable = durable
        self._nc: Optional[Any] = None
        self._js: Optional[Any] = None
        self._sub: Optional[Any] = None

    async def connect(self) -> "NatsScheduler":
        import nats
        from nats.js.errors import BadRequestError
        self._nc = await nats.connect(self._url)
        self._js = self._nc.jetstream()
        try:
            await self._js.add_stream(name=self._stream, subjects=[self._subject])
        except BadRequestError:
            # The stream already exists — the only condition this call is allowed to
            # tolerate. Anything else (auth, permissions, an unreachable broker) must
            # propagate: swallowing it here would leave the scheduler "connected" to a
            # stream that does not exist. Confirm the pre-existing stream actually
            # carries our subject; a same-named stream bound elsewhere would accept
            # every publish and deliver none, which in a durable runtime surfaces as
            # runs that silently never start rather than as an error.
            info = await self._js.stream_info(self._stream)
            subjects = list(getattr(info.config, "subjects", None) or ())
            if self._subject not in subjects:
                raise RuntimeError(
                    f"JetStream stream {self._stream!r} already exists but does not "
                    f"carry subject {self._subject!r} (subjects={subjects!r}); refusing "
                    f"to enqueue run ids that would never be delivered."
                ) from None
        self._sub = await self._js.pull_subscribe(self._subject, durable=self._durable)
        return self

    async def enqueue(self, run_id: str) -> None:
        assert self._js is not None, "scheduler not connected"
        await self._js.publish(self._subject, run_id.encode())

    async def dequeue(self) -> str:
        assert self._sub is not None, "scheduler not connected"
        while True:
            msgs = await self._sub.fetch(1, timeout=None)
            if msgs:
                msg = msgs[0]
                await msg.ack()  # at-least-once; the lease makes processing idempotent
                data: bytes = msg.data
                return data.decode()

    async def close(self) -> None:
        if self._nc is not None:
            await self._nc.close()
