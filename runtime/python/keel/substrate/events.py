from __future__ import annotations
from enum import Enum
from typing import Any, Optional
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict


class EventType(str, Enum):
    RUN_STARTED = "run.started"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    RUN_CANCELLED = "run.cancelled"
    RUN_PAUSED = "run.paused"
    RUN_RESUMED = "run.resumed"
    STEP_SCHEDULED = "step.scheduled"
    STEP_STARTED = "step.started"
    STEP_COMPLETED = "step.completed"
    STEP_FAILED = "step.failed"
    STEP_RETRIED = "step.retried"
    STEP_SKIPPED = "step.skipped"
    LLM_REQUEST = "llm.request"
    LLM_RESPONSE = "llm.response"
    LLM_STREAM_CHUNK_SUMMARY = "llm.stream_chunk_summary"
    TOOL_REQUEST = "tool.request"
    TOOL_RESPONSE = "tool.response"
    TOOL_DENIED = "tool.denied"
    # memory subsystem (additive since the Phase-1 freeze; see ADR-0007)
    MEMORY_READ = "memory.read"
    MEMORY_WRITE = "memory.write"
    ROUTE_DECIDED = "route.decided"
    BUDGET_WARNING = "budget.warning"
    BUDGET_EXCEEDED = "budget.exceeded"
    GATE_OPENED = "gate.opened"
    GATE_APPROVED = "gate.approved"
    GATE_REJECTED = "gate.rejected"
    GATE_EXPIRED = "gate.expired"
    POLICY_VIOLATION = "policy.violation"
    GOVERNANCE_REQUESTED = "governance.requested"
    GOVERNANCE_DECIDED = "governance.decided"
    GOVERNANCE_ESCALATED = "governance.escalated"
    GOVERNANCE_UNAVAILABLE = "governance.unavailable"


class TokenUsage(BaseModel):
    model_config = ConfigDict(frozen=True)
    input: int = 0
    output: int = 0
    model: str = ""


# The envelope schema version every event carries. A reader dispatches on (type,
# schema_version) and upcasts older events to this shape at read time — see
# keel.substrate.upcast and docs/EVENT-SCHEMA.md. Bump only with a registered upcaster.
SCHEMA_VERSION = 1


class Event(BaseModel):
    """Immutable. Once written, never mutated. Run state is a fold over these."""

    model_config = ConfigDict(frozen=True)

    schema_version: int = SCHEMA_VERSION
    event_id: str
    run_id: str
    seq: int = Field(..., ge=0, description="strictly monotonic per run")
    ts: datetime
    type: EventType
    node_id: Optional[str] = None
    attempt: int = 1
    payload_ref: Optional[str] = None
    tokens: Optional[TokenUsage] = None
    cost_usd: float = 0.0
    parent_span: Optional[str] = None
    data: dict[str, Any] = Field(default_factory=dict)

    def to_json(self) -> str:
        return self.model_dump_json()

    @classmethod
    def from_json(cls, raw: str) -> "Event":
        return cls.model_validate_json(raw)
