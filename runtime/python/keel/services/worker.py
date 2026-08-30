"""Leased worker loop.

Wraps the Phase-1 executor (via the Runner) with lease acquisition + heartbeating so
the *same* executor code runs unmodified in an N-worker cluster. A worker pulls a run
id from the scheduler, acquires its lease, resumes it (fold -> frontier -> run), and
releases. If the worker dies mid-run its lease expires and another worker steals the
run and resumes from the frontier — completed steps are never re-run, hence never
re-billed.
"""
from __future__ import annotations
import asyncio
import contextlib
from typing import Optional
from ..executor.lease import LeaseManager
from ..executor.state import RunState
from .runner import Runner
from .scheduler import Scheduler


class LeasedRunLoop:
    def __init__(self, runner: Runner, scheduler: Scheduler, leases: LeaseManager,
                 worker_id: str, heartbeat_s: float = 5.0) -> None:
        self._runner = runner
        self._scheduler = scheduler
        self._leases = leases
        self.worker_id = worker_id
        self._heartbeat_s = heartbeat_s

    async def _heartbeat(self, run_id: str) -> None:
        try:
            while True:
                await asyncio.sleep(self._heartbeat_s)
                await self._leases.heartbeat(run_id, self.worker_id)
        except asyncio.CancelledError:
            pass

    async def serve_run(self, run_id: str) -> Optional[RunState]:
        """Lease the given run, resume it (fold -> frontier -> run), and release.
        Returns None if another worker holds the lease. If this coroutine is cancelled
        mid-resume (a worker 'death'), the lease is still released in ``finally`` so any
        other worker can steal the run and resume it from the frontier — completed steps
        are never re-run, hence never re-billed."""
        if not await self._leases.acquire(run_id, self.worker_id):
            return None  # someone else owns it
        hb = asyncio.create_task(self._heartbeat(run_id))
        try:
            return await self._runner.resume(run_id)
        finally:
            hb.cancel()
            # Await the heartbeat's teardown, suppressing its cancellation. If the run
            # finished before the loop ever scheduled the heartbeat coroutine's first
            # step, the cancel is delivered at the coroutine's entry — before its own
            # try/except is active — so it surfaces here; swallow it so a fast run does
            # not turn lease cleanup into a spurious failure.
            with contextlib.suppress(asyncio.CancelledError):
                await hb
            await self._leases.release(run_id, self.worker_id)

    async def serve_once(self) -> Optional[RunState]:
        """Process exactly one run id from the scheduler. Returns its final state, or
        None if the lease was held by another worker (the run was skipped)."""
        run_id = await self._scheduler.dequeue()
        return await self.serve_run(run_id)

    async def serve_forever(self) -> None:  # pragma: no cover - exercised via serve_once
        while True:
            await self.serve_once()
