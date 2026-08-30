"""M2: the golden corpus of historical logs replays byte-identically under the current
code (regression gate — a schema change that breaks old-log replay fails here until an
upcaster is supplied), and the upcaster chain migrates an older event forward."""
import base64
import json
from pathlib import Path

import pytest

from keel.kir.schema import Graph
from keel.substrate.ports import MemoryBlobStore
from keel.substrate.upcast import (UpcasterRegistry, UnreadableEvent, read_event)
from keel.services.replay import replay_recorded

CORPUS = Path(__file__).parent / "corpus"
CORPUS_FILES = sorted(CORPUS.glob("*.json"))


def _load(path: Path):
    bundle = json.loads(path.read_text())
    blobs = MemoryBlobStore()
    for digest, b64 in bundle["blobs"].items():
        ref = blobs.put(base64.b64decode(b64))
        assert ref.endswith(digest)
    graph = Graph.model_validate(bundle["graph"])
    events = [read_event(e) for e in bundle["events"]]  # upcast to current schema
    return graph, events, blobs


def test_corpus_is_present():
    assert len(CORPUS_FILES) >= 3, "golden corpus missing; run `python -m tests.golden._gen_corpus`"


@pytest.mark.parametrize("path", CORPUS_FILES, ids=lambda p: p.stem)
@pytest.mark.asyncio
async def test_golden_log_replays_byte_identical(path):
    graph, events, blobs = _load(path)
    result = await replay_recorded(graph, path.stem, events, blobs)
    assert result.identical, f"{path.name}: {result.detail}"


# --- the upcaster chain: an event recorded on schema n reads under n+1 ---
def _v1_event() -> dict:
    return {"schema_version": 1, "event_id": "e0", "run_id": "r", "seq": 0,
            "ts": "2026-01-01T00:00:00+00:00", "type": "llm.request", "node_id": "a",
            "attempt": 1, "payload_ref": None, "tokens": None, "cost_usd": 0.0,
            "parent_span": None, "data": {"legacy_model": "m1"}}


def test_upcaster_migrates_v1_to_v2():
    reg = UpcasterRegistry(current=2)

    def v1_to_v2(d: dict) -> dict:
        # a representative migration: rename a data key
        d["data"] = {**d.get("data", {})}
        if "legacy_model" in d["data"]:
            d["data"]["model"] = d["data"].pop("legacy_model")
        return d

    reg.register(1, v1_to_v2)
    ev = reg.read(_v1_event())
    assert ev.schema_version == 2
    assert ev.data == {"model": "m1"}


def test_missing_upcaster_is_loud_not_silent():
    reg = UpcasterRegistry(current=2)  # no 1->2 registered
    ok, detail = reg.is_readable(_v1_event())
    assert not ok and "no upcaster" in detail
    with pytest.raises(UnreadableEvent):
        reg.read(_v1_event())


def test_future_version_is_rejected():
    reg = UpcasterRegistry(current=1)
    future = {**_v1_event(), "schema_version": 99}
    with pytest.raises(UnreadableEvent):
        reg.read(future)


def test_current_event_reads_unchanged():
    # default registry (current schema) reads a current event without transformation
    ev = read_event(_v1_event())  # v1 == current today
    assert ev.event_id == "e0" and ev.data == {"legacy_model": "m1"}
