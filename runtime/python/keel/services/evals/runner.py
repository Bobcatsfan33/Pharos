"""Eval runner (P4-1).

Reads a recorded run's per-step outputs from the event log and checks a case's
assertions. Runs each case N times to surface flaky cases (LLM-judge assertions can
be nondeterministic) — variance is a first-class output, not a silent build failure.
"""
from __future__ import annotations
import json
import math
from typing import Optional
from ...substrate.events import EventType
from ...substrate.store.base import EventStore
from ...substrate.ports import BlobStore
from ...kir.schemas_registry import resolve_schema
from ...services.memory import Embedder, HashEmbedder
from ...services.model.port import ModelPort, ModelRequest
from .case import Assertion, AssertionType, AssertionResult, EvalCase, CaseReport


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


class EvalRunner:
    def __init__(self, store: EventStore, blobs: BlobStore, *,
                 embedder: Optional[Embedder] = None,
                 judge: Optional[ModelPort] = None) -> None:
        self._store = store
        self._blobs = blobs
        self._embedder = embedder or HashEmbedder()
        self._judge = judge

    async def _outputs(self, run_id: str) -> dict[str, bytes]:
        out: dict[str, bytes] = {}
        async for e in self._store.read_run(run_id):
            if e.type == EventType.STEP_COMPLETED and e.node_id and e.payload_ref:
                out[e.node_id] = self._blobs.get(e.payload_ref)
        return out

    def _extract(self, raw: bytes, field: Optional[str]) -> str:
        if field is None:
            return raw.decode("utf-8", "replace")
        try:
            return str(json.loads(raw)[field])
        except (json.JSONDecodeError, KeyError, TypeError):
            return raw.decode("utf-8", "replace")

    async def check(self, a: Assertion, raw: bytes) -> AssertionResult:
        actual = self._extract(raw, a.field)
        if a.type == AssertionType.EXACT:
            ok = actual.strip() == str(a.expected).strip()
            return AssertionResult(assertion=a, passed=ok, score=1.0 if ok else 0.0)
        if a.type == AssertionType.SCHEMA:
            model = resolve_schema(str(a.expected))
            if model is None:
                return AssertionResult(assertion=a, passed=False, detail="unknown schema")
            try:
                model.model_validate_json(raw)
                return AssertionResult(assertion=a, passed=True, score=1.0)
            except Exception as e:  # noqa: BLE001
                return AssertionResult(assertion=a, passed=False, detail=str(e))
        if a.type == AssertionType.NUMERIC_TOLERANCE:
            try:
                ok = abs(float(actual) - float(str(a.expected))) <= (a.tolerance or 0.0)
                return AssertionResult(assertion=a, passed=ok)
            except ValueError:
                return AssertionResult(assertion=a, passed=False, detail="not numeric")
        if a.type == AssertionType.SEMANTIC_SIMILARITY:
            sim = _cosine(self._embedder.embed(actual), self._embedder.embed(str(a.expected)))
            return AssertionResult(assertion=a, passed=sim >= (a.tolerance or 0.85),
                                   score=sim)
        if a.type == AssertionType.LLM_JUDGE:
            return await self._judge_check(a, actual)
        raise ValueError(f"unknown assertion type {a.type}")

    async def _judge_check(self, a: Assertion, actual: str) -> AssertionResult:
        if self._judge is None:
            return AssertionResult(assertion=a, passed=False, detail="no judge configured")
        prompt = (f"Rubric: {a.rubric}\n\nOutput to judge:\n{actual}\n\n"
                  'Return ONLY JSON: {"pass": bool, "score": number, "reason": string}')
        resp = await self._judge.complete(ModelRequest(
            model=a.judge_model or "judge", messages=[{"role": "user", "content": prompt}],
            max_tokens=256))
        try:
            verdict = json.loads(resp.text)
            return AssertionResult(assertion=a, passed=bool(verdict["pass"]),
                                   score=float(verdict.get("score", 0.0)),
                                   detail=str(verdict.get("reason", "")))
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            return AssertionResult(assertion=a, passed=False, detail=f"bad judge output: {e}")

    async def run_case(self, case: EvalCase) -> list[AssertionResult]:
        outputs = await self._outputs(case.recorded_run_id)
        results = []
        for a in case.assertions:
            raw = outputs.get(a.node_id)
            if raw is None:
                results.append(AssertionResult(assertion=a, passed=False,
                                               detail=f"no output for node {a.node_id}"))
            else:
                results.append(await self.check(a, raw))
        return results

    async def run_suite(self, cases: list[EvalCase], n_flake: int = 3
                        ) -> dict[str, object]:
        reports: list[CaseReport] = []
        for case in cases:
            passes = 0
            for _ in range(n_flake):
                results = await self.run_case(case)
                if all(r.passed for r in results):
                    passes += 1
            reports.append(CaseReport(case_id=case.case_id, passed=passes, of=n_flake))
        return {
            "cases": [r.model_dump() for r in reports],
            "passed": sum(1 for r in reports if r.ok),
            "failed": sum(1 for r in reports if not r.ok and not r.flaky),
            "flaky": [r.case_id for r in reports if r.flaky],
            "total": len(reports),
        }
