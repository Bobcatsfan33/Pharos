"""Regression testing as a workflow (M5).

A *regression bundle* is a recorded run captured into a single self-contained,
version-controllable JSON file: the graph, its full event log, every blob the log
references, and an optional eval case. Because a recorded run already carries its
model responses and tool outputs in the log (M1/M4), a bundle replays **with no API
key and no network** — which is exactly what lets a GitHub Action replay it on every
pull request and block the merge if the runtime's behaviour drifts.

Two regressions are caught:

  * **Determinism drift** — the bundle no longer replays byte-identically (a change
    leaked nondeterminism, reordered the event log, or altered serialization). This is
    the core durable-execution guarantee; any drift fails the suite.
  * **Behavioural drift** — the bundle's optional eval case (assertions over step
    outputs) no longer passes. The recorded outputs are fixed, so this catches changes
    to how outputs are extracted, validated, or scored.

The bundle format is deliberately boring: a stable, documented JSON contract a human
can read in a diff. Capture with ``keel regress record``; check a directory of them
with ``keel regress run`` (and in CI via ``.github/workflows/regression.yml``).
"""
from __future__ import annotations

import base64
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..kir.schema import Graph
from ..substrate.events import Event
from ..substrate.ports import BlobStore, MemoryBlobStore
from .evals import EvalCase, EvalRunner
from .replay import replay_recorded

BUNDLE_FORMAT = "keel.regression/1"


class RegressionBundle(BaseModel):
    """A recorded run, frozen for replay-as-a-test. Self-contained and portable."""

    model_config = ConfigDict(frozen=True)

    format: str = BUNDLE_FORMAT
    bundle_id: str
    run_id: str
    graph: dict[str, Any]
    events: list[dict[str, Any]]
    blobs: dict[str, str] = Field(default_factory=dict)  # blob ref -> base64(bytes)
    eval_case: Optional[dict[str, Any]] = None


class RegressionFinding(BaseModel):
    """The verdict for one bundle. ``regressed`` is the only thing CI gates on."""

    model_config = ConfigDict(frozen=True)

    bundle_id: str
    replay_identical: bool
    replay_detail: str
    eval_passed: Optional[int] = None
    eval_of: Optional[int] = None
    eval_flaky: bool = False
    eval_detail: str = ""

    @property
    def regressed(self) -> bool:
        if not self.replay_identical:
            return True
        if self.eval_of is not None and not self.eval_flaky:
            return self.eval_passed != self.eval_of
        return False


def capture_bundle(*, bundle_id: str, run_id: str, graph: Graph, events: list[Event],
                   blobs: BlobStore, eval_case: Optional[EvalCase] = None
                   ) -> RegressionBundle:
    """Freeze a recorded run into a portable bundle. Every blob referenced by any
    event's ``payload_ref`` is inlined (base64) so the bundle replays standalone."""
    refs = {e.payload_ref for e in events if e.payload_ref}
    packed: dict[str, str] = {}
    for ref in sorted(r for r in refs if r):
        packed[ref] = base64.b64encode(blobs.get(ref)).decode("ascii")
    return RegressionBundle(
        bundle_id=bundle_id,
        run_id=run_id,
        graph=graph.model_dump(by_alias=True),
        events=[e.model_dump(mode="json") for e in events],
        blobs=packed,
        eval_case=eval_case.model_dump() if eval_case is not None else None,
    )


def _hydrate(bundle: RegressionBundle) -> tuple[Graph, list[Event], MemoryBlobStore]:
    graph = Graph.model_validate(bundle.graph)
    events = [Event.model_validate(e) for e in bundle.events]
    blobs = MemoryBlobStore()
    for ref, b64 in bundle.blobs.items():
        # Content-addressed: put() recomputes the digest, so the round-tripped ref
        # must equal the recorded one or the bundle is internally inconsistent.
        got = blobs.put(base64.b64decode(b64))
        if got != ref:
            raise ValueError(f"bundle {bundle.bundle_id}: blob ref mismatch {ref} != {got}")
    return graph, events, blobs


async def check_bundle(bundle: RegressionBundle, *, n_flake: int = 3) -> RegressionFinding:
    """Replay the bundle byte-identically and (if present) run its eval case."""
    graph, events, blobs = _hydrate(bundle)
    replay = await replay_recorded(graph, bundle.run_id, events, blobs)

    eval_passed = eval_of = None
    eval_flaky = False
    eval_detail = ""
    if bundle.eval_case is not None:
        case = EvalCase.model_validate(bundle.eval_case)
        runner = EvalRunner(_ReplayStore(events), blobs)
        passes = 0
        for _ in range(max(1, n_flake)):
            results = await runner.run_case(case)
            if all(r.passed for r in results):
                passes += 1
            else:
                eval_detail = "; ".join(
                    f"{r.assertion.node_id}:{r.detail or 'failed'}"
                    for r in results if not r.passed) or eval_detail
        eval_passed, eval_of = passes, max(1, n_flake)
        eval_flaky = 0 < passes < eval_of

    return RegressionFinding(
        bundle_id=bundle.bundle_id,
        replay_identical=replay.identical,
        replay_detail=replay.detail,
        eval_passed=eval_passed,
        eval_of=eval_of,
        eval_flaky=eval_flaky,
        eval_detail=eval_detail,
    )


async def run_suite(bundles: list[RegressionBundle], *, n_flake: int = 3
                    ) -> dict[str, Any]:
    """Check every bundle. The suite fails iff any bundle regressed."""
    findings = [await check_bundle(b, n_flake=n_flake) for b in bundles]
    regressed = [f.bundle_id for f in findings if f.regressed]
    flaky = [f.bundle_id for f in findings if f.eval_flaky]
    return {
        "total": len(findings),
        "passed": sum(1 for f in findings if not f.regressed),
        "regressed": regressed,
        "flaky": flaky,
        "findings": [f.model_dump() for f in findings],
    }


class _ReplayStore:
    """A read-only EventStore view over an in-memory event list, so EvalRunner can read
    a bundle's recorded step outputs without a database."""

    def __init__(self, events: list[Event]) -> None:
        self._events = events

    async def append_batch(self, events: list[Event]) -> None:  # pragma: no cover
        raise NotImplementedError("regression replay store is read-only")

    async def read_run(self, run_id: str) -> Any:
        for e in self._events:
            yield e

    async def list_runs(self, limit: int = 100) -> list[str]:  # pragma: no cover
        return []
