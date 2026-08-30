# KEEL — Detailed Engineering Roadmap & Reference Implementation

**Version:** 2.0 (developer build-out of handoff spec v1.0)
**Audience:** Founding engineering team — read top to bottom, then work from the per-ticket tables.
**Status:** Authoritative build guide. Every code block here is a *reference implementation*, not pseudocode. Where a block is marked `# REFERENCE`, it is expected to compile and pass the tests described alongside it. Deviations require an ADR.
**How this differs from v1.0:** v1.0 set the thesis, invariants, architecture, and phase gates. This document keeps all of that and adds the thing a team actually needs to start typing: the real module layout, the load-bearing code for the headline component of every phase, the data contracts in enforceable form, and a ticket-by-ticket decomposition with acceptance criteria mapped to tests.

---

## How to read this document

The five non-negotiable invariants from v1.0 (*nothing invisible, nothing lost, nothing unbounded, everything testable, the simple path is the safe path*) are the acceptance criteria behind every line of code below. Each phase section has three parts:

1. **The headline implementation** — the single hardest, most load-bearing component of the phase, written out in full so there is no ambiguity about how the moat actually works.
2. **Supporting interfaces** — the ports and contracts the rest of the phase's work plugs into.
3. **Ticket breakdown** — a table of discrete, assignable units of work, each with its acceptance criterion and the test that proves it.

Code targets **Python 3.11+**, `asyncio`-only (ADR-003), **Pydantic v2** as the schema substrate (ADR-004). Type annotations are mandatory and `mypy --strict` is CI-gated on L1–L4.

---

## Repository layout

This is the canonical package structure. The layer numbers (L1–L5) from the architecture map directly onto packages, and `import-linter` enforces that dependencies only point downward.

```
keel/
├── pyproject.toml                 # core deps lean; extras: [pg], [nats], [viewer], [sandbox]
├── keel/
│   ├── __init__.py
│   ├── substrate/                 # L1 — no upward imports, ever
│   │   ├── ports.py               # Clock, IdGen, Rng, BlobStore protocols
│   │   ├── events.py              # Event envelope, taxonomy, serialization
│   │   ├── tracebus.py            # ring buffer + async writer + OTel export
│   │   ├── store/
│   │   │   ├── base.py            # EventStore protocol
│   │   │   ├── sqlite.py          # zero-dependency default
│   │   │   └── postgres.py        # keel[pg]
│   │   └── redact.py              # PII/secret redaction (runs pre-persist)
│   ├── executor/                  # L2 — durable, event-sourced state machine
│   │   ├── state.py               # RunState fold + frontier computation
│   │   ├── engine.py              # the scheduler/executor loop
│   │   ├── lease.py               # worker leasing (Phase 2)
│   │   ├── replay.py              # time-travel replay (Phase 2)
│   │   └── gate.py                # human-in-the-loop parking (Phase 2)
│   ├── services/                  # L3 — model router, budgeter, tools, evals, policy
│   │   ├── model/
│   │   │   ├── port.py            # ModelPort protocol + normalized errors
│   │   │   ├── providers/         # openai.py, anthropic.py, ollama.py
│   │   │   └── router.py          # model_policy resolution (Phase 3)
│   │   ├── budget.py              # budget engine (Phase 3)
│   │   ├── context.py             # context compiler (Phase 3)
│   │   ├── tools/
│   │   │   ├── contract.py        # typed tool contracts
│   │   │   └── gateway.py         # out-of-process execution (Phase 4)
│   │   ├── evals/                 # eval harness (Phase 4)
│   │   └── policy.py              # policy engine + RBAC (Phase 4)
│   ├── kir/                       # L4 — intermediate representation + compiler
│   │   ├── schema.py              # KIR node/graph models + validator
│   │   └── compile.py             # DX → KIR lowering
│   ├── authoring/                 # L5 — Agent/Task/Crew + decorators
│   │   └── api.py
│   ├── viewer/                    # keel view (FastAPI + static SPA)
│   └── cli.py                     # keel run|view|replay|diff|simulate|test|audit
└── tests/
    ├── unit/
    ├── property/                  # Hypothesis: serialization + fold invariants
    ├── chaos/                     # process/worker kill, 429 storms, malformed output
    └── golden/                    # recorded runs → eval cases
```

A few rules that the layout encodes and CI enforces:

- **L1 imports nothing from KEEL above it.** The substrate is the only place that touches a clock, a random number generator, a database driver, or the network. Everything else receives those capabilities through ports. This is what makes deterministic replay possible — if a higher layer could call `time.time()` directly, replay would diverge.
- **The core install is lean.** `pip install keel` pulls SQLite (stdlib), `pydantic`, `httpx`, and the OTel SDK. Postgres, NATS, the viewer's web stack, and the subprocess sandbox are all extras. Adding a runtime dependency to core requires an ADR.

---

## L1 — The substrate (foundational base shared by every phase)

Nothing in the phase plan works without this layer being correct first. It is small on purpose. Every nondeterministic capability the rest of the system needs is funneled through a *port* here, and every port has a "record" implementation (used live) and the events it emits are what a "replay" implementation reads back. This is the single mechanism behind both *nothing is invisible* and *nothing is lost*.

### 1.1 Ports — the only doorway to nondeterminism

```python
# keel/substrate/ports.py   # REFERENCE
from __future__ import annotations
from typing import Protocol, runtime_checkable
from datetime import datetime, timezone
import os
import time as _time
import random as _random
from ulid import ULID  # python-ulid; monotonic ULIDs give us sortable run/event ids


@runtime_checkable
class Clock(Protocol):
    """The only source of 'now' in the entire system above L1."""
    def now(self) -> datetime: ...
    def monotonic(self) -> float: ...


@runtime_checkable
class IdGen(Protocol):
    """The only source of identifiers. ULIDs are lexicographically sortable
    by creation time, which is what lets us order events without a separate
    sequence service."""
    def new(self) -> str: ...


@runtime_checkable
class Rng(Protocol):
    """The only source of randomness. Seeded per-run so replay is deterministic."""
    def random(self) -> float: ...
    def choice(self, seq): ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def monotonic(self) -> float:
        return _time.monotonic()


class UlidIdGen:
    def new(self) -> str:
        return str(ULID())


class SeededRng:
    def __init__(self, seed: int) -> None:
        self._r = _random.Random(seed)

    def random(self) -> float:
        return self._r.random()

    def choice(self, seq):
        return self._r.choice(seq)


# --- Replay variants: these read recorded values instead of generating them ---

class ReplayClock:
    """Returns the timestamps that were recorded in the event log, in order.
    When a run is replayed, the executor feeds it the recorded sequence so that
    every 'now()' call returns exactly what it returned originally."""
    def __init__(self, recorded: list[datetime]) -> None:
        self._recorded = list(recorded)
        self._i = 0

    def now(self) -> datetime:
        v = self._recorded[self._i]
        self._i += 1
        return v

    def monotonic(self) -> float:
        # monotonic values are only used for local scheduling, never persisted,
        # so during replay we can return a frozen, strictly-increasing counter.
        self._i += 1
        return float(self._i)


class ReplayIdGen:
    def __init__(self, recorded: list[str]) -> None:
        self._recorded = list(recorded)
        self._i = 0

    def new(self) -> str:
        v = self._recorded[self._i]
        self._i += 1
        return v


@runtime_checkable
class BlobStore(Protocol):
    """Large payloads (prompts, responses, tool I/O) live here keyed by content
    hash; the event log only stores the reference. This keeps the event stream
    small enough to fold quickly while preserving full fidelity."""
    def put(self, data: bytes) -> str: ...        # returns 'blob:sha256:...'
    def get(self, ref: str) -> bytes: ...


class FileBlobStore:
    def __init__(self, root: str) -> None:
        self._root = root
        os.makedirs(root, exist_ok=True)

    def put(self, data: bytes) -> str:
        import hashlib
        digest = hashlib.sha256(data).hexdigest()
        path = os.path.join(self._root, digest)
        if not os.path.exists(path):
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)  # atomic; content-addressed so writes are idempotent
        return f"blob:sha256:{digest}"

    def get(self, ref: str) -> bytes:
        digest = ref.removeprefix("blob:sha256:")
        with open(os.path.join(self._root, digest), "rb") as f:
            return f.read()
```

The pattern to internalize: **a port is a `Protocol` with a live implementation and a replay implementation.** Higher layers depend on the protocol, never the concrete class. The executor decides at run-construction time which one to inject. There is exactly one `Clock`, one `IdGen`, one `Rng`, and one `BlobStore` per run, threaded through a `RunContext` (defined in the executor section).

### 1.2 The event envelope — frozen contract

This is the single most important data structure in the system. Its schema is frozen at Phase 1 exit; changes require an ADR *and* a migration. Everything — durability, observability, cost attribution, evals, audit — is a projection over this stream.

```python
# keel/substrate/events.py   # REFERENCE
from __future__ import annotations
from enum import Enum
from typing import Any, Optional
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict


class EventType(str, Enum):
    # run lifecycle
    RUN_STARTED = "run.started"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    RUN_CANCELLED = "run.cancelled"
    RUN_PAUSED = "run.paused"
    RUN_RESUMED = "run.resumed"
    # step lifecycle
    STEP_SCHEDULED = "step.scheduled"
    STEP_STARTED = "step.started"
    STEP_COMPLETED = "step.completed"
    STEP_FAILED = "step.failed"
    STEP_RETRIED = "step.retried"
    STEP_SKIPPED = "step.skipped"
    # model + tool
    LLM_REQUEST = "llm.request"
    LLM_RESPONSE = "llm.response"
    LLM_STREAM_CHUNK_SUMMARY = "llm.stream_chunk_summary"
    TOOL_REQUEST = "tool.request"
    TOOL_RESPONSE = "tool.response"
    TOOL_DENIED = "tool.denied"
    # routing, budget, gates, policy
    ROUTE_DECIDED = "route.decided"
    BUDGET_WARNING = "budget.warning"
    BUDGET_EXCEEDED = "budget.exceeded"
    GATE_OPENED = "gate.opened"
    GATE_APPROVED = "gate.approved"
    GATE_REJECTED = "gate.rejected"
    GATE_EXPIRED = "gate.expired"
    POLICY_VIOLATION = "policy.violation"


class TokenUsage(BaseModel):
    model_config = ConfigDict(frozen=True)
    input: int = 0
    output: int = 0
    model: str = ""


class Event(BaseModel):
    """Immutable. Once written, never mutated. State is a fold over these."""
    model_config = ConfigDict(frozen=True)

    event_id: str
    run_id: str
    seq: int = Field(..., ge=0, description="strictly monotonic per run")
    ts: datetime
    type: EventType
    node_id: Optional[str] = None
    attempt: int = 1
    payload_ref: Optional[str] = None     # blob:sha256:... ; events stay small
    tokens: Optional[TokenUsage] = None
    cost_usd: float = 0.0
    parent_span: Optional[str] = None     # OTel span id for correlation
    # 'data' holds small, structured, queryable fields that must stay inline
    # (e.g. route reason, gate decision, error taxonomy). Large blobs go to payload_ref.
    data: dict[str, Any] = Field(default_factory=dict)

    def to_json(self) -> str:
        return self.model_dump_json()

    @classmethod
    def from_json(cls, raw: str) -> "Event":
        return cls.model_validate_json(raw)
```

The split between `data` (small, inline, queryable) and `payload_ref` (large, blob-stored) is deliberate. A 10k-event run must fold in under the performance budget; you cannot do that if every event carries a 30 KB prompt inline. The viewer and the cost dashboard query `data`, `tokens`, and `cost_usd` directly; they only dereference `payload_ref` when a developer drills into a specific step.

### 1.3 The trace bus — tracing that cannot be turned off

The bus is the spine of invariant #1. The executor emits into an in-process ring buffer that never blocks the hot path; an async writer drains it to the event store and the OTel exporter. Tracing can be *redirected* (to `/dev/null` for the overhead benchmark, to Postgres in prod) but there is no API to disable it.

```python
# keel/substrate/tracebus.py   # REFERENCE
from __future__ import annotations
import asyncio
from typing import Optional
from .events import Event
from .store.base import EventStore
from .redact import Redactor


class TraceBus:
    """In-proc ring buffer + async drainer. Emitting is non-blocking and lock-free
    on the producer side; the drainer batches writes. Backpressure is bounded:
    if the buffer fills (store is down), we apply blocking backpressure rather than
    drop control events — invariant #1 forbids silent loss."""

    def __init__(
        self,
        store: EventStore,
        redactor: Redactor,
        otel_exporter: Optional["OTelExporter"] = None,
        buffer_size: int = 4096,
        batch_size: int = 64,
    ) -> None:
        self._store = store
        self._redactor = redactor
        self._otel = otel_exporter
        self._q: asyncio.Queue[Event] = asyncio.Queue(maxsize=buffer_size)
        self._batch_size = batch_size
        self._task: Optional[asyncio.Task] = None
        self._closing = False

    async def start(self) -> None:
        self._task = asyncio.create_task(self._drain_loop(), name="tracebus-drain")

    async def emit(self, event: Event) -> None:
        # Redaction runs BEFORE persistence and before it ever leaves the process.
        event = self._redactor.scrub(event)
        # Bounded queue → if the store is wedged we block the producer instead of
        # dropping. Control events are never sampled away.
        await self._q.put(event)

    async def _drain_loop(self) -> None:
        batch: list[Event] = []
        while not (self._closing and self._q.empty()):
            try:
                ev = await asyncio.wait_for(self._q.get(), timeout=0.05)
                batch.append(ev)
            except asyncio.TimeoutError:
                pass
            if batch and (len(batch) >= self._batch_size or self._q.empty()):
                await self._store.append_batch(batch)
                if self._otel is not None:
                    for e in batch:
                        self._otel.export(e)
                batch.clear()

    async def close(self) -> None:
        self._closing = True
        if self._task is not None:
            await self._task
```

```python
# keel/substrate/redact.py   # REFERENCE
from __future__ import annotations
import re
from typing import Pattern
from .events import Event

_DEFAULT_PATTERNS: list[Pattern[str]] = [
    re.compile(r"(?i)\b(sk-[a-z0-9]{20,})\b"),                  # API keys
    re.compile(r"(?i)\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),  # emails
    re.compile(r"(?i)bearer\s+[a-z0-9._\-]+"),                  # bearer tokens
]


class Redactor:
    """Pluggable. Runs on the trace bus BEFORE persistence so secrets never touch
    disk. Default set covers keys/tokens/emails; tenants extend it."""

    def __init__(self, patterns: list[Pattern[str]] | None = None) -> None:
        self._patterns = patterns or _DEFAULT_PATTERNS

    def _scrub_str(self, s: str) -> str:
        for p in self._patterns:
            s = p.sub("[REDACTED]", s)
        return s

    def _scrub_obj(self, o):
        if isinstance(o, str):
            return self._scrub_str(o)
        if isinstance(o, dict):
            return {k: self._scrub_obj(v) for k, v in o.items()}
        if isinstance(o, list):
            return [self._scrub_obj(v) for v in o]
        return o

    def scrub(self, event: Event) -> Event:
        if not event.data:
            return event
        return event.model_copy(update={"data": self._scrub_obj(event.data)})
```

### 1.4 The event store port — SQLite default, Postgres extra

```python
# keel/substrate/store/base.py   # REFERENCE
from __future__ import annotations
from typing import Protocol, AsyncIterator, runtime_checkable
from ..events import Event


@runtime_checkable
class EventStore(Protocol):
    async def append_batch(self, events: list[Event]) -> None:
        """Append events. MUST enforce (run_id, seq) uniqueness so a double-write
        after a crash is rejected rather than duplicated — this is what makes the
        log the single source of truth."""
        ...

    async def read_run(self, run_id: str) -> AsyncIterator[Event]:
        """Yield all events for a run in ascending seq order."""
        ...

    async def list_runs(self, limit: int = 100) -> list[str]: ...
```

```python
# keel/substrate/store/sqlite.py   # REFERENCE
from __future__ import annotations
import aiosqlite
from typing import AsyncIterator
from ..events import Event

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    run_id     TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    event_id   TEXT NOT NULL,
    ts         TEXT NOT NULL,
    type       TEXT NOT NULL,
    node_id    TEXT,
    body       TEXT NOT NULL,           -- full Event JSON
    PRIMARY KEY (run_id, seq)           -- the durability invariant, enforced by the DB
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
"""


class SqliteEventStore:
    def __init__(self, path: str = "keel.db") -> None:
        self._path = path
        self._db: aiosqlite.Connection | None = None

    async def open(self) -> None:
        self._db = await aiosqlite.connect(self._path)
        await self._db.executescript(_SCHEMA)
        # WAL mode: concurrent readers (viewer) don't block the writer (executor).
        await self._db.execute("PRAGMA journal_mode=WAL;")
        await self._db.commit()

    async def append_batch(self, events: list[Event]) -> None:
        assert self._db is not None
        rows = [
            (e.run_id, e.seq, e.event_id, e.ts.isoformat(), e.type.value,
             e.node_id, e.to_json())
            for e in events
        ]
        try:
            await self._db.executemany(
                "INSERT INTO events(run_id, seq, event_id, ts, type, node_id, body)"
                " VALUES (?,?,?,?,?,?,?)",
                rows,
            )
            await self._db.commit()
        except aiosqlite.IntegrityError as e:
            # (run_id, seq) collision = a replayed/duplicate write. Reject loudly;
            # the executor treats this as 'already persisted' and continues.
            await self._db.rollback()
            raise DuplicateEventError(str(e)) from e

    async def read_run(self, run_id: str) -> AsyncIterator[Event]:
        assert self._db is not None
        async with self._db.execute(
            "SELECT body FROM events WHERE run_id=? ORDER BY seq ASC", (run_id,)
        ) as cur:
            async for (body,) in cur:
                yield Event.from_json(body)

    async def list_runs(self, limit: int = 100) -> list[str]:
        assert self._db is not None
        async with self._db.execute(
            "SELECT DISTINCT run_id FROM events ORDER BY run_id DESC LIMIT ?", (limit,)
        ) as cur:
            return [r[0] async for r in cur]


class DuplicateEventError(Exception):
    pass
```

The Postgres adapter (`keel[pg]`) implements the same protocol with `INSERT ... ON CONFLICT (run_id, seq) DO NOTHING RETURNING seq` so a duplicate write is a no-op the executor can detect, plus advisory locks for worker leasing (Phase 2). Because both sit behind `EventStore`, **the executor code is identical against either backend** — swapping is a config line, exactly as the constraints table demands.

---

## PHASE 1 — Core Runtime + Authoring (Months 1–3)

**Pillars:** 1 (observability foundation), 2 (durability start), 7 (sane defaults).
**Phase goal:** `pip install keel`, define agents/crews with CrewAI-comparable ergonomics, run them on a durable, fully-traced local runtime, browse the trace. Kill the process mid-run and resume without re-billing completed model calls.

### Headline implementation: the event-sourced durable executor

This is the moat. If this is correct, durability and observability are *properties of the architecture* rather than features bolted on. The whole design rests on one equation: **current state is a pure fold over the event log.** There is no mutable run state anywhere — not in memory, not in a row that gets `UPDATE`d. To know what a run is doing, you replay its events into a `RunState`. To resume after a crash, you do exactly the same fold and then schedule whatever the fold says is unfinished.

#### KIR — the thing the executor actually runs

The executor never sees `Agent` or `Crew`. Those are L5 authoring sugar that compile down to KIR (L4). The executor only runs KIR, which is why we can add new authoring styles later without touching the runtime.

```python
# keel/kir/schema.py   # REFERENCE
from __future__ import annotations
from enum import Enum
from typing import Any, Optional, Literal
from pydantic import BaseModel, Field, ConfigDict, model_validator


class NodeType(str, Enum):
    LLM_STEP = "llm_step"
    TOOL_STEP = "tool_step"
    ROUTER = "router"
    MAP = "map"          # fan-out
    REDUCE = "reduce"
    HUMAN_GATE = "human_gate"
    SUBGRAPH = "subgraph"
    CREW = "crew"        # bounded autonomous region


class Retry(BaseModel):
    model_config = ConfigDict(frozen=True)
    max: int = 0
    backoff: Literal["none", "linear", "exp"] = "exp"
    on: list[str] = Field(default_factory=lambda: ["rate_limit", "transient"])


class NodeBudget(BaseModel):
    model_config = ConfigDict(frozen=True)
    max_tokens: Optional[int] = None
    max_usd: Optional[float] = None
    max_steps: Optional[int] = None       # meaningful for crew/subgraph regions


class Node(BaseModel):
    model_config = ConfigDict(frozen=True)
    id: str
    type: NodeType
    model_policy: str = "default"
    input_schema: Optional[str] = None    # 'ref:schemas/Doc'
    output_schema: Optional[str] = None   # structured output ENFORCED when present
    tool: Optional[str] = None            # for tool_step
    retry: Retry = Field(default_factory=Retry)
    budget: NodeBudget = Field(default_factory=NodeBudget)
    # crew/subgraph carry a nested contract
    region: Optional["Region"] = None
    config: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check(self) -> "Node":
        if self.type in (NodeType.CREW, NodeType.SUBGRAPH) and self.region is None:
            raise ValueError(f"node {self.id}: {self.type} requires a 'region'")
        if self.type == NodeType.TOOL_STEP and not self.tool:
            raise ValueError(f"node {self.id}: tool_step requires 'tool'")
        return self


class Region(BaseModel):
    """The bounded contract around a crew's autonomy. Inside, agents self-organize;
    the boundary is rigid — this is the architectural answer to Flows-vs-Crews."""
    model_config = ConfigDict(frozen=True)
    max_steps: int
    max_tokens: int
    allowed_tools: list[str] = Field(default_factory=list)
    output_schema: str
    nodes: list["Node"] = Field(default_factory=list)
    edges: list["Edge"] = Field(default_factory=list)


class Edge(BaseModel):
    model_config = ConfigDict(frozen=True)
    from_: str = Field(..., alias="from")
    to: str
    when: Optional[str] = None             # CEL-ish guard; None = unconditional


class Graph(BaseModel):
    model_config = ConfigDict(frozen=True)
    kir_version: str = "1.0"
    graph_id: str
    nodes: list[Node]
    edges: list[Edge]

    @model_validator(mode="after")
    def _validate_graph(self) -> "Graph":
        ids = [n.id for n in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate node ids")
        idset = set(ids)
        for e in self.edges:
            if e.from_ not in idset:
                raise ValueError(f"edge from unknown node '{e.from_}'")
            if e.to not in idset:
                raise ValueError(f"edge to unknown node '{e.to}'")
        # acyclicity is required at the top level (cycles live inside crew regions only)
        self._assert_acyclic(ids, self.edges)
        return self

    @staticmethod
    def _assert_acyclic(ids: list[str], edges: list["Edge"]) -> None:
        adj: dict[str, list[str]] = {i: [] for i in ids}
        for e in edges:
            adj[e.from_].append(e.to)
        WHITE, GRAY, BLACK = 0, 1, 2
        color = {i: WHITE for i in ids}

        def visit(n: str) -> None:
            color[n] = GRAY
            for m in adj[n]:
                if color[m] == GRAY:
                    raise ValueError(f"cycle through node '{m}' (use a crew region for loops)")
                if color[m] == WHITE:
                    visit(m)
            color[n] = BLACK

        for i in ids:
            if color[i] == WHITE:
                visit(i)


Node.model_rebuild()
Region.model_rebuild()
```

The validator does real work: duplicate ids, dangling edges, and top-level acyclicity are rejected with messages that *name the node* (acceptance criterion for the KIR ticket). Loops are not forbidden globally — they are confined to `crew` regions, where the `Region` contract (max_steps, max_tokens) guarantees termination.

#### RunState — the fold

```python
# keel/executor/state.py   # REFERENCE
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
from ..substrate.events import Event, EventType
from ..kir.schema import Graph


@dataclass
class StepRecord:
    node_id: str
    status: str                      # scheduled|started|completed|failed|skipped
    attempt: int = 1
    result_ref: Optional[str] = None # blob ref of the completed output
    error: Optional[dict] = None


@dataclass
class RunState:
    """The authoritative current state, derived ONLY by folding events.
    Never constructed by mutation from outside the fold."""
    run_id: str
    graph: Graph
    steps: dict[str, StepRecord] = field(default_factory=dict)
    status: str = "pending"
    total_cost_usd: float = 0.0
    total_tokens_in: int = 0
    total_tokens_out: int = 0
    next_seq: int = 0
    # recorded nondeterminism, replayed back through ports
    recorded_ts: list = field(default_factory=list)
    recorded_ids: list = field(default_factory=list)

    @classmethod
    def fold(cls, run_id: str, graph: Graph, events: list[Event]) -> "RunState":
        st = cls(run_id=run_id, graph=graph)
        for e in events:
            st._apply(e)
        return st

    def _apply(self, e: Event) -> None:
        # seq must be strictly monotonic and gap-free — a core invariant the
        # property tests assert on every generated event sequence.
        if e.seq != self.next_seq:
            raise ValueError(
                f"event log gap/disorder: expected seq {self.next_seq}, got {e.seq}"
            )
        self.next_seq = e.seq + 1
        self.recorded_ts.append(e.ts)
        self.recorded_ids.append(e.event_id)

        if e.type == EventType.RUN_STARTED:
            self.status = "running"
        elif e.type == EventType.RUN_COMPLETED:
            self.status = "completed"
        elif e.type == EventType.RUN_FAILED:
            self.status = "failed"
        elif e.type == EventType.RUN_PAUSED:
            self.status = "paused"
        elif e.type == EventType.STEP_SCHEDULED:
            self.steps[e.node_id] = StepRecord(e.node_id, "scheduled", e.attempt)
        elif e.type == EventType.STEP_STARTED:
            self.steps[e.node_id].status = "started"
            self.steps[e.node_id].attempt = e.attempt
        elif e.type == EventType.STEP_COMPLETED:
            rec = self.steps[e.node_id]
            rec.status = "completed"
            rec.result_ref = e.payload_ref
        elif e.type == EventType.STEP_FAILED:
            self.steps[e.node_id].status = "failed"
            self.steps[e.node_id].error = e.data.get("error")
        elif e.type == EventType.STEP_SKIPPED:
            self.steps[e.node_id] = StepRecord(e.node_id, "skipped")

        if e.tokens is not None:
            self.total_tokens_in += e.tokens.input
            self.total_tokens_out += e.tokens.output
        self.total_cost_usd += e.cost_usd

    def frontier(self) -> list[str]:
        """The set of nodes that are runnable *now*: every predecessor completed
        or skipped, and the node itself is not yet completed/started. This is the
        whole resume algorithm — after a crash we fold, call frontier(), and
        schedule exactly these. Completed steps are never re-run, hence never
        re-billed."""
        done = {
            nid for nid, r in self.steps.items()
            if r.status in ("completed", "skipped")
        }
        preds: dict[str, list[str]] = {n.id: [] for n in self.graph.nodes}
        for e in self.graph.edges:
            preds[e.to].append(e.from_)
        ready: list[str] = []
        for n in self.graph.nodes:
            if n.id in done:
                continue
            rec = self.steps.get(n.id)
            if rec and rec.status in ("started",):
                # was mid-flight when we crashed → it's on the frontier to retry,
                # because a non-idempotent side effect may or may not have landed.
                ready.append(n.id)
                continue
            if all(p in done for p in preds[n.id]):
                ready.append(n.id)
        return ready
```

`frontier()` is the resume algorithm in eight lines of logic. There is no separate "recovery" code path — normal scheduling and crash recovery are *the same code*, because both just ask the fold "what's runnable?" That equivalence is why the kill-`-9`-and-resume acceptance test is not a special case we have to maintain; it falls out of the design.

#### The engine loop

```python
# keel/executor/engine.py   # REFERENCE
from __future__ import annotations
import asyncio
from typing import Optional
from ..substrate.events import Event, EventType, TokenUsage
from ..substrate.ports import Clock, IdGen, Rng, BlobStore
from ..substrate.tracebus import TraceBus
from ..substrate.store.base import EventStore
from ..kir.schema import Graph, Node, NodeType
from .state import RunState


class RunContext:
    """One per run. Holds the injected ports so that NOTHING below calls a clock,
    rng, or id generator directly. During replay these are the Replay* variants."""
    def __init__(self, run_id: str, clock: Clock, ids: IdGen, rng: Rng,
                 blobs: BlobStore, bus: TraceBus, state: RunState) -> None:
        self.run_id = run_id
        self.clock = clock
        self.ids = ids
        self.rng = rng
        self.blobs = blobs
        self.bus = bus
        self.state = state

    async def emit(self, type: EventType, *, node_id: Optional[str] = None,
                   attempt: int = 1, payload: Optional[bytes] = None,
                   tokens: Optional[TokenUsage] = None, cost_usd: float = 0.0,
                   data: Optional[dict] = None) -> Event:
        ref = self.blobs.put(payload) if payload is not None else None
        ev = Event(
            event_id=self.ids.new(),
            run_id=self.run_id,
            seq=self.state.next_seq,
            ts=self.clock.now(),
            type=type,
            node_id=node_id,
            attempt=attempt,
            payload_ref=ref,
            tokens=tokens,
            cost_usd=cost_usd,
            data=data or {},
        )
        # Fold into local state FIRST (advances seq), then persist. If we crash
        # between, the persisted log is still gap-free; the un-persisted event is
        # simply regenerated on resume because the step wasn't marked complete.
        self.state._apply(ev)
        await self.bus.emit(ev)
        return ev


# A node handler turns a node + its inputs into a completed-step event.
NodeHandler = "Callable[[RunContext, Node, dict], Awaitable[bytes]]"


class Executor:
    def __init__(self, store: EventStore, bus: TraceBus, blobs: BlobStore,
                 handlers: dict[NodeType, "NodeHandler"]) -> None:
        self._store = store
        self._bus = bus
        self._blobs = blobs
        self._handlers = handlers

    async def run(self, graph: Graph, ctx: RunContext) -> RunState:
        st = ctx.state
        if st.status == "pending":
            await ctx.emit(EventType.RUN_STARTED)
        elif st.status in ("running", "paused"):
            # we are RESUMING — announce the seam so the trace shows it explicitly
            await ctx.emit(EventType.RUN_RESUMED)

        while True:
            frontier = st.frontier()
            if not frontier:
                break
            # Parallelism: independent frontier nodes run concurrently. asyncio
            # gives us this for free since node handlers are coroutines.
            await asyncio.gather(*(self._run_node(graph, ctx, nid) for nid in frontier))
            if st.status in ("paused", "failed"):
                return st

        await ctx.emit(EventType.RUN_COMPLETED)
        return st

    async def _run_node(self, graph: Graph, ctx: RunContext, node_id: str) -> None:
        node = next(n for n in graph.nodes if n.id == node_id)
        rec = ctx.state.steps.get(node_id)
        attempt = (rec.attempt + 1) if rec and rec.status == "started" else 1

        await ctx.emit(EventType.STEP_SCHEDULED, node_id=node_id, attempt=attempt)
        await ctx.emit(EventType.STEP_STARTED, node_id=node_id, attempt=attempt)

        handler = self._handlers[node.type]
        inputs = self._gather_inputs(graph, ctx, node)
        try:
            result_bytes = await handler(ctx, node, inputs)
        except RetryableError as err:
            if attempt <= node.retry.max:
                await ctx.emit(EventType.STEP_RETRIED, node_id=node_id, attempt=attempt,
                               data={"reason": err.taxonomy})
                await self._backoff(node, attempt, ctx)
                return await self._run_node(graph, ctx, node_id)
            await ctx.emit(EventType.STEP_FAILED, node_id=node_id, attempt=attempt,
                           data={"error": {"type": err.taxonomy, "msg": str(err)}})
            await ctx.emit(EventType.RUN_FAILED)
            ctx.state.status = "failed"
            return
        except FatalError as err:
            await ctx.emit(EventType.STEP_FAILED, node_id=node_id, attempt=attempt,
                           data={"error": {"type": "permanent", "msg": str(err)}})
            await ctx.emit(EventType.RUN_FAILED)
            ctx.state.status = "failed"
            return

        await ctx.emit(EventType.STEP_COMPLETED, node_id=node_id, attempt=attempt,
                       payload=result_bytes)

    def _gather_inputs(self, graph: Graph, ctx: RunContext, node: Node) -> dict:
        """Pull predecessors' completed outputs from the blob store. Because results
        live in the log, a resumed run reads them back instead of recomputing —
        this is the 'completed LLM steps are replayed, never re-billed' guarantee."""
        preds = [e.from_ for e in graph.edges if e.to == node.id]
        out: dict = {}
        for p in preds:
            rec = ctx.state.steps.get(p)
            if rec and rec.result_ref:
                out[p] = ctx.blobs.get(rec.result_ref)
        return out

    async def _backoff(self, node: Node, attempt: int, ctx: RunContext) -> None:
        import math
        if node.retry.backoff == "none":
            return
        base = 0.5
        delay = base * attempt if node.retry.backoff == "linear" else base * math.pow(2, attempt)
        await asyncio.sleep(delay)


class RetryableError(Exception):
    def __init__(self, msg: str, taxonomy: str = "transient") -> None:
        super().__init__(msg)
        self.taxonomy = taxonomy


class FatalError(Exception):
    pass
```

The subtle correctness point is the ordering inside `RunContext.emit`: we **fold into in-memory state before we persist**. If the process dies in the gap, the persisted log is still gap-free and consistent; the only consequence is that the not-yet-persisted event never happened from the log's perspective, so on resume the step is simply re-attempted. Combined with `(run_id, seq)` uniqueness in the store, this means a duplicate write after recovery is rejected rather than corrupting the log. That is the entire durability story, and it is small enough to audit.

### Supporting interface: ModelPort + normalized errors

```python
# keel/services/model/port.py   # REFERENCE
from __future__ import annotations
from typing import Protocol, AsyncIterator, Optional, runtime_checkable
from pydantic import BaseModel


class ModelRequest(BaseModel):
    model: str
    messages: list[dict]                 # OpenAI-style role/content
    max_tokens: int
    temperature: float = 0.0
    response_schema: Optional[dict] = None   # JSON schema for structured output


class ModelResponse(BaseModel):
    text: str
    tokens_in: int
    tokens_out: int
    model: str
    finish_reason: str


class ModelError(Exception):
    """Every provider error is normalized into ONE taxonomy so the executor's
    retry logic never has to know which vendor it's talking to."""
    TAXONOMY = {"rate_limit", "overloaded", "context_length", "auth",
                "transient", "permanent"}

    def __init__(self, taxonomy: str, msg: str, retry_after: Optional[float] = None):
        assert taxonomy in self.TAXONOMY
        super().__init__(msg)
        self.taxonomy = taxonomy
        self.retry_after = retry_after


@runtime_checkable
class ModelPort(Protocol):
    async def complete(self, req: ModelRequest) -> ModelResponse: ...
    def stream(self, req: ModelRequest) -> AsyncIterator[str]: ...
    def count_tokens(self, text: str, model: str) -> int: ...
```

Each provider (`openai.py`, `anthropic.py`, `ollama.py`) maps its SDK's exceptions onto `ModelError`'s six-value taxonomy against recorded fixtures. The executor's `RetryableError` is produced from `rate_limit`/`overloaded`/`transient`; `auth`/`permanent` become `FatalError`; `context_length` triggers the context compiler (Phase 3) rather than a blind retry. **A provider swap is one config line** because nothing above the port references a vendor SDK type.

### Supporting interface: structured-output enforcement (the LLM node handler)

```python
# keel/services/model/llm_handler.py   # REFERENCE
from __future__ import annotations
import json
from pydantic import ValidationError
from ..model.port import ModelPort, ModelRequest, ModelResponse
from ...executor.engine import RunContext, RetryableError, FatalError
from ...substrate.events import EventType, TokenUsage
from ...kir.schema import Node
from ...kir.schemas_registry import resolve_schema   # maps 'ref:schemas/Summary' -> Pydantic model


def make_llm_handler(model_port: ModelPort, price_table: dict):
    async def handle(ctx: RunContext, node: Node, inputs: dict) -> bytes:
        prompt = _assemble_prompt(node, inputs)   # Phase 3 replaces this with the context compiler
        model = _resolve_model(node.model_policy)  # Phase 3 replaces with the router
        req = ModelRequest(model=model, messages=prompt,
                           max_tokens=node.budget.max_tokens or 4096)

        schema_model = resolve_schema(node.output_schema) if node.output_schema else None
        if schema_model is not None:
            req.response_schema = schema_model.model_json_schema()

        max_reprompts = 2
        last_err: str | None = None
        for attempt in range(max_reprompts + 1):
            await ctx.emit(EventType.LLM_REQUEST, node_id=node.id,
                           payload=json.dumps(req.messages).encode(),
                           data={"model": model, "reprompt": attempt})
            resp: ModelResponse = await model_port.complete(req)
            cost = _price(resp, price_table)
            await ctx.emit(EventType.LLM_RESPONSE, node_id=node.id,
                           payload=resp.text.encode(),
                           tokens=TokenUsage(input=resp.tokens_in, output=resp.tokens_out,
                                             model=resp.model),
                           cost_usd=cost)
            if schema_model is None:
                return resp.text.encode()
            try:
                validated = schema_model.model_validate_json(resp.text)
                return validated.model_dump_json().encode()
            except ValidationError as ve:
                # Bounded re-prompt with the validator's own feedback. Never pass
                # malformed output downstream — invariant: typed success or typed failure.
                last_err = str(ve)
                req.messages = prompt + [
                    {"role": "assistant", "content": resp.text},
                    {"role": "user",
                     "content": f"Your output failed schema validation:\n{ve}\n"
                                f"Return ONLY valid JSON matching the schema."},
                ]
        # Exhausted re-prompts → a TYPED failure event, not a silent malformed pass.
        raise FatalError(f"structured_output_unsatisfied after {max_reprompts} reprompts: {last_err}")

    return handle
```

This handler is where invariant #1 (nothing invisible) and the "structured output ENFORCED" KIR field become concrete. Every request and response is an event with tokens and cost attached; a schema violation is bounded-retried with the validator's message fed back to the model, and if it still fails the run produces a *typed* failure event rather than leaking malformed JSON to the next node. The Phase 1 chaos test points an adversarial mock model at this and asserts it converges or fails-typed on 100% of runs.

### Phase 1 — ticket breakdown

| # | Ticket | Owner | Acceptance criterion | Proving test |
|---|--------|-------|----------------------|--------------|
| P1-1 | KIR v1 schema + validator | Runtime | Malformed graphs rejected with node-naming errors; round-trips losslessly | `property/test_kir_roundtrip.py` (Hypothesis), `unit/test_kir_validation.py` |
| P1-2 | Event envelope + SQLite store | Runtime | `(run_id, seq)` uniqueness enforced; duplicate write rejected | `unit/test_store_dupe.py` |
| P1-3 | RunState fold + frontier | Runtime | Fold rejects seq gaps; frontier = exactly runnable nodes | `property/test_fold_invariants.py` |
| P1-4 | Executor loop (seq/parallel/crew) | Runtime | kill-`-9` mid-run → resume → completes; completed LLM steps not re-invoked | `chaos/test_kill_resume.py` (mock provider call-count assertion) |
| P1-5 | TraceBus + redactor | Obs/FE | Tracing cannot be disabled; secrets scrubbed pre-persist | `unit/test_redact.py`, `unit/test_bus_backpressure.py` |
| P1-6 | ModelPort + 3 providers | DX | Provider swap = 1 config line; error taxonomy matches fixtures | `unit/test_provider_errors.py` |
| P1-7 | Structured-output handler | DX | Adversarial mock converges or fails-typed 100% | `chaos/test_structured_output.py` |
| P1-8 | Authoring API (Agent/Task/Crew + decorators) | DX | CrewAI researcher+writer ports in ≤25 lines; golden KIR snapshot | `golden/test_crewai_port.py` |
| P1-9 | `keel view` v1 | Obs/FE | External dev finds failing step+prompt in <60s | usability test (3 devs) |
| P1-10 | Trace-overhead benchmark in CI | DevEx | <3% p95 vs `/dev/null` sink | `chaos/bench_overhead.py` (CI-gated) |

**Phase 1 exit gate (live demo by a non-author):** port a real CrewAI example, run it, `kill -9` mid-run, resume, show the full trace including the resume seam, then swap Anthropic→Ollama with one line.

---

## PHASE 2 — Durability at Depth + Observability Product (Months 4–6)

**Pillars:** 2 (complete), 1 (complete), 3 (instrumentation half).
**Phase goal:** runs survive anything, pause for humans indefinitely with zero compute while parked, and replay with time-travel; traces flow into the customer's existing observability stack.

### Headline implementation: human-in-the-loop gates + multi-worker leasing

These two are one design problem wearing two hats. A human gate parks a run for an unbounded time; a worker lease lets *any* worker pick up *any* parked or orphaned run. Both rely on the same fact established in Phase 1 — **a run is fully described by its event log** — so "parked" and "crashed" are indistinguishable to a fresh worker: it folds the log, sees the frontier, and either continues or finds a gate blocking it.

#### The gate handler — parking with zero compute

```python
# keel/executor/gate.py   # REFERENCE
from __future__ import annotations
from ..substrate.events import EventType
from ..executor.engine import RunContext
from ..kir.schema import Node


class GatePaused(Exception):
    """Raised by the gate handler to unwind the run loop cleanly. The run is NOT
    failed — it is parked. No worker holds it; no coroutine sleeps on it. It is
    purely a state in the log until an external approval appends a GATE_* event."""


async def human_gate_handler(ctx: RunContext, node: Node, inputs: dict) -> bytes:
    # If an approval/rejection already exists in the log (we are resuming AFTER the
    # human acted), honor it and complete the step.
    decision = _find_decision(ctx, node.id)
    if decision is None:
        await ctx.emit(EventType.GATE_OPENED, node_id=node.id,
                       data={"prompt": node.config.get("prompt", ""),
                             "ttl_s": node.config.get("ttl_s"),
                             "context": _summarize(inputs)})
        await ctx.emit(EventType.RUN_PAUSED)
        ctx.state.status = "paused"
        raise GatePaused(node.id)
    if decision == "rejected":
        from ..executor.engine import FatalError
        raise FatalError(f"human rejected gate {node.id}")
    # approved or edited → the edited payload (if any) becomes this step's output
    return _approved_payload(ctx, node.id)


def _find_decision(ctx: RunContext, node_id: str) -> str | None:
    for e in _events_for_node(ctx, node_id):
        if e.type == EventType.GATE_APPROVED:
            return "approved"
        if e.type == EventType.GATE_REJECTED:
            return "rejected"
        if e.type == EventType.GATE_EXPIRED:
            return "rejected"
    return None
```

```python
# keel/executor/gate_api.py   # REFERENCE — the external approval path
from __future__ import annotations
from ..substrate.events import Event, EventType
from ..substrate.store.base import EventStore
from ..substrate.ports import Clock, IdGen, BlobStore
from .state import RunState
from ..kir.schema import Graph


class GateService:
    """Approving a gate is just appending an event and re-queuing the run for any
    worker. It deliberately does NOT need the original worker, the original
    process, or even the original machine."""

    def __init__(self, store: EventStore, ids: IdGen, clock: Clock,
                 blobs: BlobStore, scheduler: "Scheduler") -> None:
        self._store = store
        self._ids = ids
        self._clock = clock
        self._blobs = blobs
        self._scheduler = scheduler

    async def approve(self, run_id: str, node_id: str, edited_payload: bytes | None = None) -> None:
        await self._append_decision(run_id, node_id, EventType.GATE_APPROVED, edited_payload)
        # Wake the run: enqueue it for leasing. Any idle worker resumes it within ~1s.
        await self._scheduler.enqueue(run_id)

    async def reject(self, run_id: str, node_id: str) -> None:
        await self._append_decision(run_id, node_id, EventType.GATE_REJECTED, None)
        await self._scheduler.enqueue(run_id)

    async def _append_decision(self, run_id, node_id, etype, payload) -> None:
        graph = await self._scheduler.load_graph(run_id)
        events = [e async for e in self._store.read_run(run_id)]
        st = RunState.fold(run_id, graph, events)
        ref = self._blobs.put(payload) if payload else None
        ev = Event(event_id=self._ids.new(), run_id=run_id, seq=st.next_seq,
                   ts=self._clock.now(), type=etype, node_id=node_id, payload_ref=ref)
        await self._store.append_batch([ev])
```

#### Worker leasing — any worker resumes any run

```python
# keel/executor/lease.py   # REFERENCE (Postgres backend; SQLite single-node skips this)
from __future__ import annotations
import asyncio
from datetime import timedelta
from ..substrate.ports import Clock


LEASE_TTL = timedelta(seconds=30)
HEARTBEAT = timedelta(seconds=10)


class LeaseManager:
    """Cooperative leasing via Postgres advisory locks + a leases table. A worker
    must hold a live lease to append run events; a dead worker's lease expires and
    another worker steals it. Combined with (run_id, seq) uniqueness, a brief
    double-lease during a partition cannot corrupt the log — the loser's append
    collides on seq and is rejected."""

    def __init__(self, pool, worker_id: str, clock: Clock) -> None:
        self._pool = pool
        self._worker_id = worker_id
        self._clock = clock

    async def acquire(self, run_id: str) -> bool:
        async with self._pool.acquire() as con:
            # pg_try_advisory_lock is non-blocking; hashtext maps run_id → bigint key
            got = await con.fetchval(
                "SELECT pg_try_advisory_lock(hashtext($1))", run_id)
            if not got:
                return False
            now = self._clock.now()
            # steal if existing lease is expired
            row = await con.fetchrow(
                """INSERT INTO leases(run_id, worker_id, expires_at)
                   VALUES ($1,$2,$3)
                   ON CONFLICT (run_id) DO UPDATE
                     SET worker_id=$2, expires_at=$3
                     WHERE leases.expires_at < $4
                   RETURNING worker_id""",
                run_id, self._worker_id, now + LEASE_TTL, now)
            return row is not None and row["worker_id"] == self._worker_id

    async def heartbeat(self, run_id: str) -> None:
        async with self._pool.acquire() as con:
            await con.execute(
                "UPDATE leases SET expires_at=$1 WHERE run_id=$2 AND worker_id=$3",
                self._clock.now() + LEASE_TTL, run_id, self._worker_id)

    async def release(self, run_id: str) -> None:
        async with self._pool.acquire() as con:
            await con.execute(
                "DELETE FROM leases WHERE run_id=$1 AND worker_id=$2",
                run_id, self._worker_id)
            await con.execute("SELECT pg_advisory_unlock(hashtext($1))", run_id)


class LeasedRunLoop:
    """Wraps the Phase-1 Executor with lease acquisition + heartbeating so the exact
    same executor code runs unmodified in a 3-worker cluster."""

    def __init__(self, leases: LeaseManager, executor, scheduler) -> None:
        self._leases = leases
        self._executor = executor
        self._scheduler = scheduler

    async def serve_forever(self) -> None:
        while True:
            run_id = await self._scheduler.dequeue()       # NATS JetStream pull
            if not await self._leases.acquire(run_id):
                continue                                    # someone else has it
            hb = asyncio.create_task(self._heartbeat_loop(run_id))
            try:
                await self._executor.resume(run_id)         # fold → frontier → run
            finally:
                hb.cancel()
                await self._leases.release(run_id)
```

The acceptance criterion — *3-worker cluster, kill workers randomly under 500 concurrent runs for 1 hour, zero lost/duplicated steps* — is guaranteed by two facts working together: a stolen lease lets a new worker pick up an orphaned run, and the `(run_id, seq)` primary key means the original worker (if it briefly comes back during a network partition) cannot double-append. The invariant checker in the chaos suite folds every run's log at the end and asserts monotonic gap-free seq with no orphaned `started` steps.

### Supporting implementation: time-travel replay

Replay is where the L1 port discipline pays off completely. Because every nondeterministic value was recorded, we can re-drive the executor through `ReplayClock`/`ReplayIdGen` and get a byte-identical run — or splice in an edited state and go live from that point.

```python
# keel/executor/replay.py   # REFERENCE
from __future__ import annotations
import json
from ..substrate.ports import ReplayClock, ReplayIdGen, SeededRng
from ..substrate.store.base import EventStore
from ..kir.schema import Graph
from .state import RunState
from .engine import Executor, RunContext


async def replay(store: EventStore, graph: Graph, run_id: str,
                 from_step: str | None = None, patch: dict | None = None,
                 live_llm: bool = False, *, blobs, bus, handlers) -> RunState:
    events = [e async for e in store.read_run(run_id)]
    st = RunState.fold(run_id, graph, events)

    if from_step is None and not live_llm:
        # Pure recorded replay: feed recorded ts/ids back; assert byte-identity.
        ctx = RunContext(run_id, ReplayClock(st.recorded_ts), ReplayIdGen(st.recorded_ids),
                         SeededRng(0), _RecordedBlobs(blobs, events), bus,
                         RunState.fold(run_id, graph, []))
        replayed = await Executor(store, bus, blobs, handlers).run(graph, ctx)
        assert _logs_identical(events, replayed), "replay diverged — nondeterminism leak"
        return replayed

    # Patched / live replay: truncate the log at `from_step`, optionally overwrite
    # that step's input with `patch`, then continue with LIVE ports downstream.
    truncated = _truncate_at(events, from_step)
    st2 = RunState.fold(run_id, graph, truncated)
    if patch is not None:
        st2.steps[from_step].result_ref = blobs.put(json.dumps(patch).encode())
    # downstream of the patch runs live; everything upstream is replayed from log
    new_run_id = f"{run_id}:replay"
    ...
    return st2
```

The acceptance criteria fall straight out: *recorded replay is byte-identical* (asserted by `_logs_identical`), and *a patched replay diverges only downstream of the patch* (everything before `from_step` is read from the original log; only nodes after it execute live). `keel diff <run_a> <run_b>` then walks both logs node-by-node and reports prompt/output/route/cost deltas — the same machinery that becomes the eval substrate in Phase 4.

### Phase 2 — ticket breakdown

| # | Ticket | Owner | Acceptance criterion | Proving test |
|---|--------|-------|----------------------|--------------|
| P2-1 | Postgres event store behind `EventStore` | Runtime | Identical executor behavior vs SQLite; `ON CONFLICT` dedupe | `unit/test_pg_parity.py` |
| P2-2 | Worker leasing + heartbeat/steal | Runtime | 3 workers, random kills, 500 concurrent, 1h → zero lost/dup steps | `chaos/test_worker_kill.py` + invariant checker |
| P2-3 | NATS JetStream scheduler | Runtime | At-least-once dequeue; idempotent via lease | `unit/test_scheduler_nats.py` |
| P2-4 | Human-gate node + GateService API | Runtime | Parks with zero compute; survives cluster restart + 7-day mocked wait; approve resumes <1s | `chaos/test_gate_survival.py` |
| P2-5 | Gate UI + webhook notify | Obs/FE | Approve/reject/edit from viewer; webhook fires | `unit/test_gate_webhook.py` |
| P2-6 | Time-travel replay (`keel replay`) | Runtime | Recorded replay byte-identical; patch diverges only downstream | `unit/test_replay_identity.py` |
| P2-7 | Trace diffing (`keel diff`) | DX | Diff highlights only genuine divergences | `golden/test_diff.py` |
| P2-8 | OTel GenAI export + 3 vendor guides | DevEx | Spans nest correctly w/ token attrs in Datadog/Tempo/Jaeger | `unit/test_otel_spans.py` + recorded integration |
| P2-9 | Memory subsystem v1 (KV + vector ports) | DX | Reads/writes are traced events; disable = flag; prompt reconstructable | `unit/test_memory_traced.py` |
| P2-10 | Viewer v2 (timeline + gate + diff views) | Obs/FE | 10k-event run renders <2s | `chaos/bench_viewer.py` |

**Phase 2 exit gate (live):** 500 concurrent runs on 3 workers, kill a worker live; pause a run on a human gate, restart the cluster, approve, watch it finish; replay yesterday's failure with a patched state and show the diff.

---

## PHASE 3 — Cost Governance + Reliability (Months 7–9)

**Pillars:** 3 (complete), 6 (reliability half).
**Phase goal:** spend is a managed, simulated, attributed resource; the runtime is rate-limit-aware and degrades gracefully under provider 429 storms.

### Headline implementation: the budget engine

Invariant #3 — *nothing is unbounded* — is only real if there is no code path that can spend without passing the budgeter, including inside crew autonomous regions and inside retries. The budgeter is therefore not a wrapper you can forget to apply; it is consulted at the single chokepoint every spend flows through (`RunContext.emit` for any event that carries `cost_usd`/`tokens`) and at every step boundary. Budgets compose across scopes — a node spend counts against its node budget, its enclosing crew region's budget, the run budget, and the tenant budget simultaneously.

```python
# keel/services/budget.py   # REFERENCE
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class BudgetAction(str, Enum):
    WARN = "warn"     # emit event + webhook, keep going
    PAUSE = "pause"   # park like a human gate, resumable after raise
    KILL = "kill"     # typed failure


@dataclass(frozen=True)
class Budget:
    max_usd: Optional[float] = None
    max_tokens: Optional[int] = None
    max_steps: Optional[int] = None
    max_wallclock_s: Optional[float] = None
    action: BudgetAction = BudgetAction.PAUSE
    warn_at: float = 0.8          # warn at 80% of any limit

    # The default that ships with EVERY run unless explicitly overridden.
    # 'unlimited' must be written as a literal Budget(max_usd=None, ...) on purpose.
    @staticmethod
    def default() -> "Budget":
        return Budget(max_usd=5.0, max_steps=100, action=BudgetAction.PAUSE)


@dataclass
class Meter:
    usd: float = 0.0
    tokens: int = 0
    steps: int = 0
    started_monotonic: float = 0.0


class BudgetExceeded(Exception):
    def __init__(self, scope: str, dimension: str, limit: float, action: BudgetAction):
        super().__init__(f"budget {scope}.{dimension} exceeded (limit={limit})")
        self.scope = scope
        self.dimension = dimension
        self.action = action


class Budgeter:
    """Holds nested scopes (tenant → run → crew → node). check() is called BEFORE a
    spend is committed and at every step boundary. Because the executor calls this
    at the one chokepoint all spend flows through, there is provably no bypass —
    the chaos suite asserts this by attempting to spend inside crew regions and
    retries and verifying every path halts."""

    def __init__(self, clock) -> None:
        self._clock = clock
        self._budgets: dict[str, Budget] = {}
        self._meters: dict[str, Meter] = {}

    def register(self, scope: str, budget: Budget) -> None:
        self._budgets[scope] = budget
        self._meters[scope] = Meter(started_monotonic=self._clock.monotonic())

    def _scopes_for(self, node_scope: str) -> list[str]:
        # 'tenant:acme/run:01H.../crew:research/node:summarize' → all ancestor scopes
        parts = node_scope.split("/")
        return ["/".join(parts[: i + 1]) for i in range(len(parts))]

    def would_breach(self, node_scope: str, add_usd: float, add_tokens: int) -> Optional[BudgetExceeded]:
        """Pure predicate — does NOT mutate. Lets the executor decide-then-act
        atomically so a breach halts within one step boundary of the limit."""
        for scope in self._scopes_for(node_scope):
            b = self._budgets.get(scope)
            m = self._meters.get(scope)
            if not b or not m:
                continue
            if b.max_usd is not None and m.usd + add_usd > b.max_usd:
                return BudgetExceeded(scope, "usd", b.max_usd, b.action)
            if b.max_tokens is not None and m.tokens + add_tokens > b.max_tokens:
                return BudgetExceeded(scope, "tokens", b.max_tokens, b.action)
            if b.max_steps is not None and m.steps + 1 > b.max_steps:
                return BudgetExceeded(scope, "steps", b.max_steps, b.action)
            if b.max_wallclock_s is not None:
                if self._clock.monotonic() - m.started_monotonic > b.max_wallclock_s:
                    return BudgetExceeded(scope, "wallclock", b.max_wallclock_s, b.action)
        return None

    def commit(self, node_scope: str, add_usd: float, add_tokens: int) -> list[str]:
        """Apply the spend across all ancestor scopes; return scopes crossing warn_at
        so the executor can emit budget.warning events."""
        warnings = []
        for scope in self._scopes_for(node_scope):
            b, m = self._budgets.get(scope), self._meters.get(scope)
            if not b or not m:
                continue
            m.usd += add_usd
            m.tokens += add_tokens
            m.steps += 1
            if b.max_usd and m.usd >= b.warn_at * b.max_usd:
                warnings.append(scope)
        return warnings
```

The executor integrates it at the step boundary so a breach halts deterministically:

```python
# keel/executor/engine.py  (budget-aware step entry — Phase 3 addition)  # REFERENCE
async def _enter_step_with_budget(self, ctx, node, est_usd, est_tokens):
    scope = ctx.scope_for(node.id)
    breach = ctx.budgeter.would_breach(scope, est_usd, est_tokens)
    if breach is not None:
        if breach.action == BudgetAction.WARN:
            await ctx.emit(EventType.BUDGET_WARNING, node_id=node.id,
                           data={"scope": breach.scope, "dimension": breach.dimension})
        elif breach.action == BudgetAction.PAUSE:
            await ctx.emit(EventType.BUDGET_EXCEEDED, node_id=node.id,
                           data={"scope": breach.scope, "action": "pause"})
            await ctx.emit(EventType.RUN_PAUSED)
            ctx.state.status = "paused"
            raise GatePaused(node.id)          # parks with full state, resumable on raise
        else:  # KILL
            await ctx.emit(EventType.BUDGET_EXCEEDED, node_id=node.id,
                           data={"scope": breach.scope, "action": "kill"})
            from .engine import FatalError
            raise FatalError(f"budget killed at {breach.scope}.{breach.dimension}")
```

Because `PAUSE` reuses the exact `GatePaused` parking mechanism from Phase 2, raising the budget and re-enqueuing the run resumes it from the boundary with full state — which is precisely the exit-gate demo (*set a $2 budget on a $5 pipeline → it pauses at the boundary; raise budget → resumes*).

### Supporting implementation: the model router

`model_policy: "default"` in KIR is resolved here at runtime. A policy is an ordered candidate list with capability tags and per-candidate cost ceilings, plus an escalation rule. Every decision emits a `route.decided` event explaining *why*, satisfying invariant #1 and the "every routing decision explains itself in the viewer" criterion.

```python
# keel/services/model/router.py   # REFERENCE
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
from .port import ModelPort, ModelRequest, ModelResponse, ModelError


@dataclass(frozen=True)
class Candidate:
    model: str
    max_cost_per_call_usd: float
    capabilities: frozenset[str]      # e.g. {'json', 'vision', 'long_context'}


@dataclass(frozen=True)
class ModelPolicy:
    name: str
    candidates: tuple[Candidate, ...]            # ordered cheapest/first-choice first
    escalate_on: frozenset[str]                  # {'validation_failure','low_confidence','budget_pressure'}


class Router:
    def __init__(self, policies: dict[str, ModelPolicy], ports: dict[str, ModelPort]) -> None:
        self._policies = policies
        self._ports = ports                       # provider name → ModelPort

    def _provider_of(self, model: str) -> str:
        return model.split(":", 1)[0]             # 'anthropic:claude-haiku-4-5'

    async def complete(self, ctx, node, req: ModelRequest,
                       required_caps: frozenset[str], under_budget_pressure: bool) -> ModelResponse:
        policy = self._policies[node.model_policy if node.model_policy != "default"
                                else self._default_policy_name]
        last_error: Optional[Exception] = None
        for i, cand in enumerate(policy.candidates):
            if not required_caps.issubset(cand.capabilities):
                continue
            if under_budget_pressure and "budget_pressure" in policy.escalate_on and i > 0:
                # under pressure, don't escalate to pricier candidates
                break
            req.model = cand.model
            await ctx.emit("route.decided", node_id=node.id, data={
                "policy": policy.name, "chosen": cand.model, "rank": i,
                "reason": "first_capable" if i == 0 else "escalation",
                "budget_pressure": under_budget_pressure})
            try:
                resp = await self._ports[self._provider_of(cand.model)].complete(req)
                return resp
            except ModelError as e:
                last_error = e
                if e.taxonomy in ("auth", "permanent", "context_length"):
                    raise                          # don't fall through on non-transient
                # provider error → fall through to next candidate (fallback)
                continue
        raise last_error or ModelError("permanent", "no capable candidate in policy")
```

The "cheap-first" exit-gate demo is a `ModelPolicy` whose first candidate is a small model and whose `escalate_on` includes `validation_failure`: the structured-output handler's re-prompt loop, on its first schema failure, asks the router to escalate, and the next candidate (a frontier model) is tried — with both the failure and the escalation visible as events. The acceptance bar (*≥60% of steps served by the small model, end-quality within 2% of all-frontier*) is measured by the Phase 4 eval harness run against the reference pipeline.

The **rate-limit-aware scheduler** (P3-3) wraps each provider port in a token bucket refilled from response rate-limit headers, with interactive runs preempting batch runs in the admission queue; the **context compiler** (P3-4) replaces the placeholder `_assemble_prompt` from Phase 1 with a measured, per-stage pipeline (system core → role block → top-k memory selection → recursive history summarization) where every stage's token contribution is a trace attribute, so the assembled prompt is byte-reconstructable from the log.

### Phase 3 — ticket breakdown

| # | Ticket | Owner | Acceptance criterion | Proving test |
|---|--------|-------|----------------------|--------------|
| P3-1 | Budget engine (run/node/crew/tenant scopes) | Runtime | Breach halts within 1 step boundary; no bypass incl. crew + retries | `chaos/test_budget_no_bypass.py` |
| P3-2 | Model router + `model_policy` resolution | DX | Cheap-first: ≥60% small-model, quality within 2%; every decision explained | `golden/test_router_quality.py` |
| P3-3 | Rate-limit-aware scheduler (token buckets) | Runtime | 429-storm fixture: zero failed runs, p95 degradation <2× | `chaos/test_429_storm.py` |
| P3-4 | Context compiler (staged, measured) | DX | ≥25% token reduction, eval regression <1%; prompt reconstructable | `golden/test_context_tokens.py` |
| P3-5 | Cost simulation (`keel simulate`) | DX | Sim p50 within ±15% of actual on reference pipelines | `golden/test_simulation_accuracy.py` |
| P3-6 | Versioned price tables + update CI job | DevEx | Price table changes gate on CI; cost math unit-tested | `unit/test_pricing.py` |
| P3-7 | Cost dashboard in viewer | Obs/FE | Spend by graph/node/model/tenant/day; "most expensive step" board | `unit/test_cost_rollup.py` |

**Phase 3 exit gate (live):** set a $2 budget on a $5 pipeline → it pauses with full state at the boundary; raise budget → resumes. Show the router escalating a failed cheap-model step to the frontier model with the reasoning visible. Run cost simulation, then a real run, compare.

---

## PHASE 4 — Evals, Integration Layer, Governance (Months 10–12 → GA)

**Pillars:** 5, 6 (complete), 7.
**Phase goal:** recorded reality becomes the test suite; tools become typed, evented, and sandboxed; the runtime enforces policy at the boundary and produces audit-grade records.

### Headline implementation: the eval harness

Invariant #4 — *everything is testable* — becomes a one-command reality here: any recorded run converts to a regression test. This is cheap precisely because of the Phase 1/2 foundation. A recorded run is already a complete, deterministic event log; an eval case is that log plus a set of assertions over specific steps. `keel test record <run_id>` just reads the log and scaffolds the assertions.

```python
# keel/services/evals/case.py   # REFERENCE
from __future__ import annotations
from enum import Enum
from typing import Any, Optional
from pydantic import BaseModel


class AssertionType(str, Enum):
    EXACT = "exact"
    SCHEMA = "schema"
    NUMERIC_TOLERANCE = "numeric_tolerance"
    SEMANTIC_SIMILARITY = "semantic_similarity"   # embedding threshold
    LLM_JUDGE = "llm_judge"                        # pinned judge model + rubric


class Assertion(BaseModel):
    type: AssertionType
    node_id: str                       # which step's output we assert on
    expected: Optional[Any] = None
    tolerance: Optional[float] = None  # numeric or similarity threshold
    judge_model: Optional[str] = None  # PINNED, e.g. 'anthropic:claude-haiku-4-5@2026-05'
    rubric: Optional[str] = None


class EvalCase(BaseModel):
    case_id: str
    graph_id: str
    recorded_run_id: str
    inputs_ref: str                    # blob ref of the recorded inputs
    assertions: list[Assertion]


class AssertionResult(BaseModel):
    assertion: Assertion
    passed: bool
    score: Optional[float] = None
    detail: str = ""
```

```python
# keel/services/evals/runner.py   # REFERENCE
from __future__ import annotations
from .case import EvalCase, Assertion, AssertionType, AssertionResult


class EvalRunner:
    def __init__(self, model_port, embedder, blobs) -> None:
        self._model = model_port
        self._embedder = embedder      # text -> vector, behind a port
        self._blobs = blobs

    async def check(self, a: Assertion, actual_output: bytes) -> AssertionResult:
        actual = actual_output.decode()
        if a.type == AssertionType.EXACT:
            ok = actual.strip() == str(a.expected).strip()
            return AssertionResult(assertion=a, passed=ok, score=1.0 if ok else 0.0)

        if a.type == AssertionType.SCHEMA:
            from ...kir.schemas_registry import resolve_schema
            model = resolve_schema(a.expected)        # 'ref:schemas/Summary'
            try:
                model.model_validate_json(actual)
                return AssertionResult(assertion=a, passed=True, score=1.0)
            except Exception as e:
                return AssertionResult(assertion=a, passed=False, detail=str(e))

        if a.type == AssertionType.NUMERIC_TOLERANCE:
            try:
                ok = abs(float(actual) - float(a.expected)) <= (a.tolerance or 0)
                return AssertionResult(assertion=a, passed=ok)
            except ValueError:
                return AssertionResult(assertion=a, passed=False, detail="not numeric")

        if a.type == AssertionType.SEMANTIC_SIMILARITY:
            va = await self._embedder.embed(actual)
            ve = await self._embedder.embed(str(a.expected))
            sim = _cosine(va, ve)
            return AssertionResult(assertion=a, passed=sim >= (a.tolerance or 0.85),
                                   score=sim)

        if a.type == AssertionType.LLM_JUDGE:
            # Judge model is PINNED for reproducibility; the judge call is itself a
            # traced step like any other, so eval runs are auditable too.
            verdict = await self._judge(a, actual)
            return AssertionResult(assertion=a, passed=verdict["pass"],
                                   score=verdict["score"], detail=verdict["reason"])
        raise ValueError(a.type)

    async def run_suite(self, cases: list[EvalCase], replay_fn, n_flake: int = 3) -> dict:
        """Replays each case's graph from recorded inputs and checks assertions.
        Runs each case n_flake times and reports variance — flake detection is a
        first-class output, not an afterthought, because LLM-judge asserts can be
        nondeterministic."""
        report = {"cases": [], "flaky": []}
        for case in cases:
            outcomes = []
            for _ in range(n_flake):
                state = await replay_fn(case)
                results = [await self.check(a, self._output_of(state, a.node_id))
                           for a in case.assertions]
                outcomes.append(all(r.passed for r in results))
            passed = sum(outcomes)
            report["cases"].append({"case_id": case.case_id,
                                    "passed": passed, "of": n_flake})
            if 0 < passed < n_flake:
                report["flaky"].append(case.case_id)
        return report
```

The dogfood acceptance criterion (*KEEL's own example pipelines gated by ≥50 recorded eval cases in our CI; a seeded prompt regression is caught*) closes the loop: we use our own product to gate our own product. Golden datasets are directories in-repo; `keel test run --suite golden/` emits JUnit XML for CI; flake detection runs each case N times and reports variance so a flaky LLM-judge assertion is surfaced rather than silently failing the build.

### Supporting implementation: the tool gateway (typed, evented, sandboxed)

```python
# keel/services/tools/contract.py   # REFERENCE
from __future__ import annotations
from enum import Enum
from typing import Any
from pydantic import BaseModel


class SideEffect(str, Enum):
    READ = "read"
    WRITE = "write"
    IRREVERSIBLE = "irreversible"      # never auto-retried without idempotency key


class ToolContract(BaseModel):
    name: str
    input_schema: dict                  # JSON schema — inputs validated before exec
    output_schema: dict                 # JSON schema — outputs validated before reaching an agent
    side_effect: SideEffect
    idempotent: bool
    rate_limit_per_min: int = 60
    allowed_agents: list[str] = []      # empty = all
    # declared resource access; anything outside this is BLOCKED at runtime
    allow_network: list[str] = []       # allowlisted hosts
    allow_fs_read: list[str] = []
    allow_fs_write: list[str] = []
    timeout_s: float = 30.0
    max_output_bytes: int = 1_000_000
```

```python
# keel/services/tools/gateway.py   # REFERENCE
from __future__ import annotations
import asyncio, json
from .contract import ToolContract, SideEffect
from ...substrate.events import EventType


class ToolDenied(Exception):
    pass


class ToolGateway:
    """Tools run OUT OF PROCESS in a jailed subprocess with seccomp/resource limits
    (container backend optional). The gateway validates inputs against the contract,
    enforces allowed-agent + rate limits, runs the tool with a timeout and output
    cap, then validates the output BEFORE it can reach an agent prompt. A tool that
    reaches outside its declared access is killed and emits tool.denied."""

    def __init__(self, contracts: dict[str, ToolContract], sandbox, ratelimiter) -> None:
        self._contracts = contracts
        self._sandbox = sandbox
        self._rl = ratelimiter

    async def invoke(self, ctx, agent_id: str, tool_name: str, args: dict) -> bytes:
        c = self._contracts[tool_name]

        if c.allowed_agents and agent_id not in c.allowed_agents:
            await ctx.emit(EventType.TOOL_DENIED, data={"tool": tool_name,
                           "reason": "agent_not_allowed", "agent": agent_id})
            raise ToolDenied(f"{agent_id} may not call {tool_name}")

        _validate(args, c.input_schema)            # malformed input never executes
        await self._rl.acquire(tool_name, c.rate_limit_per_min)

        await ctx.emit(EventType.TOOL_REQUEST, data={"tool": tool_name,
                       "side_effect": c.side_effect.value},
                       payload=json.dumps(args).encode())
        try:
            raw = await asyncio.wait_for(
                self._sandbox.run(tool_name, args, limits=c), timeout=c.timeout_s)
        except SandboxViolation as v:
            # tool tried fs/network outside its declaration → blocked, evented
            await ctx.emit(EventType.TOOL_DENIED, data={"tool": tool_name,
                           "reason": "sandbox_violation", "detail": str(v)})
            raise ToolDenied(str(v)) from v

        if len(raw) > c.max_output_bytes:
            raise ToolDenied(f"{tool_name} output exceeds cap")
        _validate_json(raw, c.output_schema)        # validation barrier before any prompt
        await ctx.emit(EventType.TOOL_RESPONSE, data={"tool": tool_name},
                       payload=raw)
        return raw
```

The red-team acceptance bar (*a tool that attempts filesystem/network access outside its declaration is blocked and emits `tool.denied`; malformed tool output never reaches an agent prompt*) is enforced structurally: the sandbox blocks undeclared syscalls, and the output validation barrier sits between the tool and the agent. Webhook ingress (`POST /v1/triggers/<graph>` with HMAC verification) and NATS-subject triggers let runs start from events with no polling loops.

### Supporting implementation: the policy engine (enforcement at the boundary, not the prompt)

```python
# keel/services/policy.py   # REFERENCE
from __future__ import annotations
from dataclasses import dataclass
from typing import Protocol
from ..substrate.events import EventType


@dataclass(frozen=True)
class PolicyContext:
    principal: str            # who initiated / is approving
    action: str               # 'run' | 'approve' | 'replay' | 'tool_call'
    graph_id: str
    tool: str | None = None
    args: dict | None = None


class PolicyDecision(Protocol):
    allow: bool
    reason: str


class PolicyEngine:
    """Policies are evaluated in L3 at the runtime boundary — NOT injected as prompt
    suggestions an agent might ignore. A violation is a typed event and (configurably)
    run-fatal. CEL is the policy language (ADR-005); rules compile once and are
    evaluated per decision."""

    def __init__(self, compiled_rules, fatal_on_violation: bool = True) -> None:
        self._rules = compiled_rules
        self._fatal = fatal_on_violation

    async def enforce(self, ctx, pc: PolicyContext) -> None:
        for rule in self._rules:
            decision = rule.evaluate(pc)          # e.g. send_email.to endsWith '@company.com'
            if not decision.allow:
                await ctx.emit(EventType.POLICY_VIOLATION, data={
                    "principal": pc.principal, "action": pc.action,
                    "graph_id": pc.graph_id, "tool": pc.tool,
                    "rule": rule.name, "reason": decision.reason})
                if self._fatal:
                    from ..executor.engine import FatalError
                    raise FatalError(f"policy {rule.name} blocked {pc.action}: {decision.reason}")
                return
```

The 20/20 red-team criterion (*20 scripted violation attempts → 20 blocks, 20 audit events, 0 prompt-only mitigations*) is met because enforcement lives at the L3 boundary the executor must cross to act, so there is no "the model decided to ignore the instruction" failure mode. **Audit & retention** (P4-4) adds an optional hash-chained event log: each event carries `prev_hash = sha256(prev_event_canonical)`, making the log tamper-evident, and `keel audit export <run_id>` emits a self-contained signed bundle the bundled CLI verifier can independently check.

### Phase 4 — ticket breakdown

| # | Ticket | Owner | Acceptance criterion | Proving test |
|---|--------|-------|----------------------|--------------|
| P4-1 | Eval harness + 5 assertion types | DX | Dogfood: ≥50 cases gate our CI; seeded regression caught | `golden/` suite + `unit/test_assertions.py` |
| P4-2 | `keel test record` + JUnit + flake detection | DX | Recorded run → case in one command; variance reported | `unit/test_record_case.py` |
| P4-3 | Tool gateway + out-of-process sandbox | Runtime | Undeclared fs/network blocked + `tool.denied`; malformed output barrier | `chaos/test_tool_sandbox.py` (red-team) |
| P4-4 | Webhook/NATS triggers (HMAC) | Runtime | E2E webhook→run→callback reference app; HMAC verified | `unit/test_triggers.py` |
| P4-5 | Policy engine + RBAC (CEL) | Runtime | 20 scripted violations → 20 blocks + 20 audit events, 0 prompt-only | `chaos/test_policy_redteam.py` |
| P4-6 | Hash-chained audit log + `keel audit export` | Runtime | Bundle independently verifiable; chain tamper detected | `unit/test_audit_chain.py` |
| P4-7 | `keel import crewai <project>` converter | DX | 80% common cases convert automatically | `golden/test_crewai_import.py` |
| P4-8 | GA hardening: 5k-run/24h load, pentest, docs | DevEx | Zero data loss at scale; pentest passed; quickstart <10 min | `chaos/test_load_5k.py` |
| P4-9 | Public benchmark page (vs CrewAI/LangGraph) | DevEx | Reproducible scripts in-repo; overhead/durability/token numbers live | `bench/` reproducible harness |

**Phase 4 exit = GA criteria:** all five invariants (§0) demonstrably hold under the chaos+load suites; CrewAI migration guide validated by 3 external design partners; public reproducible benchmark page (overhead, durability, token-efficiency vs CrewAI/LangGraph on identical workloads).

---

## Cross-cutting: testing, chaos, and CI gates

The test pyramid is inverted relative to a typical app because the moat *is* correctness under failure. Property tests and chaos tests carry more weight than unit tests.

### Property tests (the executor's correctness proof)

```python
# tests/property/test_fold_invariants.py   # REFERENCE
from hypothesis import given, strategies as st
from keel.executor.state import RunState
# Strategy: generate arbitrary VALID event sequences for a fixed graph, then assert
# the three load-bearing invariants hold for every generated sequence.

@given(event_seq=valid_event_sequences())
def test_seq_is_monotonic_and_gapless(event_seq):
    st_ = RunState.fold(event_seq.run_id, event_seq.graph, event_seq.events)
    seqs = [e.seq for e in event_seq.events]
    assert seqs == list(range(len(seqs)))            # gap-free, monotonic

@given(event_seq=valid_event_sequences())
def test_no_orphan_started_steps_at_completion(event_seq):
    st_ = RunState.fold(event_seq.run_id, event_seq.graph, event_seq.events)
    if st_.status == "completed":
        assert all(r.status in ("completed", "skipped") for r in st_.steps.values())

@given(event_seq=valid_event_sequences())
def test_frontier_never_includes_completed(event_seq):
    st_ = RunState.fold(event_seq.run_id, event_seq.graph, event_seq.events)
    done = {n for n, r in st_.steps.items() if r.status == "completed"}
    assert not (set(st_.frontier()) & done)          # we never re-run completed steps
```

### The chaos suite (nightly from Phase 2)

The chaos suite scripts the failures the design claims to survive and asserts the invariants hold afterward: process `kill -9` mid-step, worker kill under concurrency, provider 429/500/timeout storms, malformed/adversarial model output, and clock skew. Its most important component is the **event-log invariant checker** that runs after every chaos scenario:

```python
# tests/chaos/invariant_checker.py   # REFERENCE
async def assert_run_log_sound(store, run_id, graph):
    events = [e async for e in store.read_run(run_id)]
    # 1. seq strictly monotonic, gap-free
    assert [e.seq for e in events] == list(range(len(events)))
    # 2. every step.started eventually has a terminal (completed/failed/skipped) OR
    #    the run is paused/failed at the frontier
    from keel.executor.state import RunState
    st = RunState.fold(run_id, graph, events)
    if st.status == "completed":
        assert all(r.status in ("completed", "skipped") for r in st.steps.values())
    # 3. no duplicate (run_id, seq) — guaranteed by store PK, re-checked here
    assert len({e.seq for e in events}) == len(events)
    # 4. cost/token totals are the sum of per-event contributions (no hidden spend)
    assert abs(st.total_cost_usd - sum(e.cost_usd for e in events)) < 1e-9
```

### CI gates (every PR)

Every PR must pass, in order: `ruff` lint → `mypy --strict` (L1–L4) → unit → property (Hypothesis on serialization + fold) → `import-linter` layer check → trace-overhead benchmark (≥ Phase 1) → chaos smoke (≥ Phase 2) → eval suite (≥ Phase 4). Red main is stop-the-line. PRs are ≤ 400 net LOC (mechanical changes exempt), no self-merge, 24h review SLA. Any cross-layer contract change (KIR, event schema, ports, tool contract) requires a merged ADR *before* implementation.

**Performance budgets, CI-gated:** trace overhead < 3% p95; executor scheduling overhead < 10 ms p95/step (local); viewer renders a 10k-event run < 2 s; resume-from-crash < 5 s for a 1k-event run.

### ADRs to write in week 1

The seven decision-log seeds become real ADRs in `/docs/adr` before any code that depends on them: (1) KIR v1 node taxonomy & versioning; (2) event envelope schema & blob-store layout; (3) asyncio-only vs anyio — *recommend asyncio-only*; (4) Pydantic v2 as schema substrate — *recommend yes*; (5) policy language CEL vs OPA vs in-house — *recommend CEL*; (6) viewer stack FastAPI + React/Vite static bundle, no SSR — *recommend yes*; (7) license split line for Phase 4 server components — *deferred to month 9*.

### Dependency map across phases

A compressed view of what blocks what, so the two infra engineers and two DX engineers can parallelize without stepping on the contract boundaries:

- **L1 substrate (ports, events, trace bus, store)** blocks *everything* — it is week-1 work and the event envelope freezes at Phase 1 exit.
- **KIR schema** blocks the executor (it runs KIR) and the authoring API (it compiles to KIR); both can start once the KIR ADR lands.
- **Durable executor** blocks worker leasing, gates, replay, the budget engine, and the eval harness — they are all projections or extensions of the event log.
- **ModelPort** blocks the router, the structured-output handler, and the context compiler.
- **Trace bus + event store** block the viewer, OTel export, cost dashboard, and audit chain.

The throughline: build L1 correctly, freeze the event envelope, and every later phase becomes a *projection over the log* rather than new infrastructure. That is the entire bet — and the reason the moat compounds instead of fragmenting.

— End of detailed build-out. Questions → architecture owner. Deviations → ADR, not Slack threads.

