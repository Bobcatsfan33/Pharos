"""Regression tests for the four `except: pass` / `except: continue` sites that ruff
0.16's widened default (S110/S112) surfaced. In a durable-execution runtime a silently
swallowed error is the worst failure mode available: the run reports success and simply
did less than it claimed. These tests pin the fixes so the silence cannot come back.
"""
import asyncio
from datetime import datetime, timezone

import pytest

from keel.substrate.events import Event, EventType
from keel.substrate.store.memory import MemoryEventStore
from keel.substrate.tracebus import TraceBus


def _ev(seq: int) -> Event:
    return Event(event_id=f"e{seq}", run_id="r", seq=seq,
                 ts=datetime.now(timezone.utc), type=EventType.STEP_STARTED, node_id="n")


# --- keel/substrate/tracebus.py -------------------------------------------------

@pytest.mark.asyncio
async def test_failing_listener_is_isolated_but_counted(capsys):
    """A broken listener still must not wedge the bus (the existing contract), but it
    is no longer invisible: every failure is counted and the first few are reported."""
    async def boom(_event: Event) -> None:
        raise RuntimeError("listener exploded")

    seen: list[int] = []

    async def healthy(event: Event) -> None:
        seen.append(event.seq)

    store = MemoryEventStore()
    bus = TraceBus(store, listeners=[boom, healthy])
    await bus.start()
    for i in range(3):
        await bus.emit(_ev(i))
    await bus.flush()
    await bus.close()

    # Isolation: persistence and the healthy listener are unaffected.
    assert [e.seq async for e in store.read_run("r")] == [0, 1, 2]
    assert seen == [0, 1, 2]
    # ...but the failure is observable rather than swallowed.
    assert bus.listener_errors == 3
    assert "listener exploded" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_healthy_listeners_record_no_errors():
    async def ok(_event: Event) -> None:
        await asyncio.sleep(0)

    bus = TraceBus(MemoryEventStore(), listeners=[ok])
    await bus.start()
    await bus.emit(_ev(0))
    await bus.flush()
    await bus.close()
    assert bus.listener_errors == 0


# --- keel/services/scheduler_nats.py --------------------------------------------

pytest.importorskip("nats")
from nats.js.errors import BadRequestError  # noqa: E402

from keel.services.scheduler_nats import NatsScheduler  # noqa: E402


class _FakeStreamConfig:
    def __init__(self, subjects):
        self.subjects = subjects


class _FakeStreamInfo:
    def __init__(self, subjects):
        self.config = _FakeStreamConfig(subjects)


class _FakeJetStream:
    """Stands in for the JetStream client so connect()'s error-handling contract can be
    exercised without a live broker (the round-trip test still needs NATS_URL)."""

    def __init__(self, add_stream_error=None, existing_subjects=None):
        self._add_stream_error = add_stream_error
        self._existing_subjects = existing_subjects
        self.subscribed = False

    async def add_stream(self, name, subjects):
        if self._add_stream_error is not None:
            raise self._add_stream_error

    async def stream_info(self, name):
        return _FakeStreamInfo(self._existing_subjects or [])

    async def pull_subscribe(self, subject, durable):
        self.subscribed = True
        return object()


class _FakeConnection:
    def __init__(self, js):
        self._js = js

    def jetstream(self):
        return self._js

    async def close(self):
        return None


@pytest.fixture
def fake_broker(monkeypatch):
    """Patches nats.connect so NatsScheduler.connect() runs for real against a fake."""
    import nats

    def _install(js):
        async def _connect(url):
            return _FakeConnection(js)
        monkeypatch.setattr(nats, "connect", _connect)
        return NatsScheduler(subject="keel.runs", stream="KEEL_RUNS")

    return _install


@pytest.mark.asyncio
async def test_existing_stream_with_matching_subject_is_tolerated(fake_broker):
    js = _FakeJetStream(add_stream_error=BadRequestError(),
                        existing_subjects=["keel.runs"])
    sched = await fake_broker(js).connect()
    assert js.subscribed
    await sched.close()


@pytest.mark.asyncio
async def test_existing_stream_bound_to_another_subject_is_refused(fake_broker):
    """The defect this replaces: a same-named stream on a different subject would
    accept every publish and deliver nothing, so runs would silently never start."""
    js = _FakeJetStream(add_stream_error=BadRequestError(),
                        existing_subjects=["something.else"])
    with pytest.raises(RuntimeError, match="would never be delivered"):
        await fake_broker(js).connect()
    assert not js.subscribed


@pytest.mark.asyncio
async def test_non_already_exists_errors_propagate(fake_broker):
    """Auth failures, permission errors and an unreachable broker must not be
    mistaken for "the stream is already there"."""
    js = _FakeJetStream(add_stream_error=PermissionError("no publish permission"))
    with pytest.raises(PermissionError):
        await fake_broker(js).connect()
    assert not js.subscribed


# --- keel/cli.py ----------------------------------------------------------------

@pytest.mark.asyncio
async def test_unparseable_suite_file_is_reported_not_silently_skipped(
    tmp_path, capsys
):
    """`keel regress run` skips files that are not bundles — but a *malformed* bundle
    used to vanish without a word, shrinking the suite while still reporting a pass.
    The file and the reason now reach stderr."""
    import argparse

    from keel import cli as engine_cli

    (tmp_path / "broken.json").write_text('{"events": [ this is not json')
    args = argparse.Namespace(action="run", suite=str(tmp_path), flake=1, junit=None)

    with pytest.raises(SystemExit):
        await engine_cli.cmd_regress(args)

    err = capsys.readouterr().err
    assert "broken.json" in err
    assert "not a valid regression bundle" in err
