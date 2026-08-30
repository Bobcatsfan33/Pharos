"""Eval case model (P4-1).

An eval case is a recorded run plus assertions over specific steps' outputs. Because
a recorded run is already a complete, deterministic event log, converting reality into
a regression test is cheap: read the log, assert on a step's output.
"""
from __future__ import annotations
from enum import Enum
from typing import Any, Optional
from pydantic import BaseModel, ConfigDict


class AssertionType(str, Enum):
    EXACT = "exact"
    SCHEMA = "schema"
    NUMERIC_TOLERANCE = "numeric_tolerance"
    SEMANTIC_SIMILARITY = "semantic_similarity"  # embedding cosine threshold
    LLM_JUDGE = "llm_judge"                       # pinned judge model + rubric


class Assertion(BaseModel):
    model_config = ConfigDict(frozen=True)
    type: AssertionType
    node_id: str
    expected: Optional[Any] = None
    tolerance: Optional[float] = None
    judge_model: Optional[str] = None  # PINNED, e.g. 'anthropic:claude-haiku-4-5@2026-05'
    rubric: Optional[str] = None
    field: Optional[str] = None        # JSON field to extract before comparing


class EvalCase(BaseModel):
    model_config = ConfigDict(frozen=True)
    case_id: str
    graph_id: str
    recorded_run_id: str
    assertions: list[Assertion]


class AssertionResult(BaseModel):
    assertion: Assertion
    passed: bool
    score: Optional[float] = None
    detail: str = ""


class CaseReport(BaseModel):
    case_id: str
    passed: int
    of: int

    @property
    def flaky(self) -> bool:
        return 0 < self.passed < self.of

    @property
    def ok(self) -> bool:
        return self.passed == self.of
