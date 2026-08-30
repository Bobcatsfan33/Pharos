# Quickstart walkthrough

A 10-minute tour from `pip install` to a durable, traced, budget-governed run you can
crash, resume, replay, budget, and turn into a regression test — all on SQLite, with
**no extra services and no "production mode" toggle**. The simple path is the safe
path (invariant #5).

Everything below uses the built-in **deterministic mock model** (`--mock`), so it runs
offline with no API key. To use a real provider, drop `--mock` and pass
`--model anthropic:claude-haiku-4-5` with `ANTHROPIC_API_KEY` set (or `openai:…`,
`ollama:…`).

---

## 0. Install

```bash
pip install keel              # core: SQLite + content-addressed blobs, zero services
pip install 'keel[viewer]'    # adds the local trace viewer (FastAPI + a static SPA)
```

By default KEEL writes its event log to `./keel.db` and blobs to `./blobs/`. Override
with `--db` / `--blobs` or the `KEEL_DB` / `KEEL_BLOBS` environment variables.

---

## 1. Define a graph (KIR)

Create `pipeline.py`. KEEL runs **KIR** — a graph of typed nodes. Exposing a
module-level `graph` is all `keel run` needs. (The optional `Agent`/`Task`/`Crew` DSL
in [`examples/authoring_dsl.py`](../examples/authoring_dsl.py) compiles to this same
KIR; it is a convenience, not the product.)

```python
# pipeline.py
from keel.kir.schema import Graph, Node, Edge, NodeType

graph = Graph(
    graph_id="demo_pipeline",
    nodes=[
        Node(id="research", type=NodeType.LLM_STEP,
             config={"model": "mock:test", "prompt": "Research the topic thoroughly."}),
        Node(id="review", type=NodeType.HUMAN_GATE,
             config={"prompt": "Editor approval before writing"}),
        Node(id="write", type=NodeType.LLM_STEP,
             config={"model": "mock:test", "prompt": "Write the article from the research."}),
    ],
    edges=[Edge.model_validate({"from": "research", "to": "review"}),
           Edge.model_validate({"from": "review", "to": "write"})],
)
```

`research → review (human gate) → write`. The gate will pause the run for a human.

---

## 2. Run it (durable + traced + budgeted, by default)

```bash
keel run pipeline.py --mock --run-id demo
```

```
run demo -> paused
  steps: {'research': 'completed', 'review': 'started'}
  cost $0.000000  tokens 10->5
```

The run **paused at the human gate with zero compute** — it is parked in the event
log, not holding a worker or a coroutine. Tracing, durability, and a default budget
(`$5` / 100 steps) were all on without you asking.

---

## 3. Inspect the trace

```bash
keel ls                  # list recorded runs
keel show demo           # the full event timeline
```

```
#   0 run.started
#   1 step.scheduled         research
#   2 step.started           research
#   3 llm.request            research
#   4 llm.response           research [10->5]
#   5 step.completed         research
#   6 step.scheduled         review
#   7 step.started           review
#   8 gate.opened            review
#   9 run.paused
```

Or browse it visually — run list, step drill-down (prompt/response/tokens/cost), the
cost dashboard, and gate approve/reject buttons:

```bash
keel view                # http://127.0.0.1:8765
```

---

## 4. Approve the gate and resume — in a fresh process

The CLI you ran in step 2 has long exited. Approving a gate is just **appending an
event to the log**; any process (or worker, or machine) can then resume the run.

```bash
keel approve demo review --resume --mock
```

```
approved gate review on demo
run demo -> completed
  steps: {'research': 'completed', 'review': 'completed', 'write': 'completed'}
  cost $0.000000  tokens 20->10
```

`keel show demo` now contains a `run.resumed` seam. Note **tokens 20→10**: the
research step completed before the pause was replayed from the log, not re-billed.
This is the same code path as crash recovery — kill the process with `kill -9`
mid-run and `keel resume demo` does exactly this.

---

## 5. Put a dollar budget on it

Budgets are metered at the one chokepoint every cost event flows through, so nothing
(retries, sub-crews) can bypass them. A breach **pauses** with full state (resumable
after a raise) or **kills** the run — your choice.

```python
# budgeted.py
from keel.kir.schema import Graph, Node, Edge, NodeType

graph = Graph(
    graph_id="budgeted",
    nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "mock:test", "prompt": "step one"}),
           Node(id="b", type=NodeType.LLM_STEP, config={"model": "mock:test", "prompt": "step two"})],
    edges=[Edge.model_validate({"from": "a", "to": "b"})],
)
```

Estimate the cost before running it:

```bash
keel simulate budgeted.py        # per-node token + $ estimate (within ~15% of actual)
```

Set a tight budget programmatically (`Runner.open(budget=Budget(max_usd=2.0,
action=BudgetAction.PAUSE))`); the run pauses at the boundary, and raising the budget
and calling `runner.resume(run_id)` continues from exactly where it stopped — with no
re-billing.

---

## 6. Time-travel replay

Because every nondeterministic input (clock, ids, model output) was recorded through
an L1 port, an executor-driven run re-drives **byte-identically**. Run a non-gated
pipeline and replay it:

```bash
keel run examples/research_pipeline.py --mock --run-id rp
keel replay rp                                     # replay OK (byte-identical)
```

(Recorded byte-identity covers executor-driven runs; runs with externally-appended
events — like a human-gate approval — replay their executor events but re-inject the
external ones, a documented extension.)

Patched replay splices an edited state and runs everything downstream **live** —
what-if debugging:

```bash
keel replay rp --from write --patch '{"answer":"a better draft"}' --mock
```

`keel diff rp other` shows exactly where two runs diverge (route / cost / payload).

---

## 7. Turn a run into a regression test

Any recorded run becomes a test case:

```bash
keel test record demo --out evals/demo.json    # scaffold assertions from the run
keel test run --suite evals/ --junit out.xml   # run the suite, emit JUnit for CI
```

Cases support five assertion types (exact, schema, numeric tolerance, semantic
similarity, pinned-judge LLM rubric). Each case runs N times so **flaky** cases are
flagged distinctly from real failures.

---

## 8. Audit-grade records

Export a tamper-evident bundle (a hash chain over the event sequence) and verify it
independently — any edit, reorder, drop, or insert breaks the chain:

```bash
export KEEL_AUDIT_SECRET=my-signing-key          # optional: HMAC-sign the head
keel audit export demo --out demo.audit.json
keel audit verify demo.audit.json                # audit OK / TAMPERED
keel audit verify demo.audit.json --json         # CI/auditor-friendly result
```

---

## 9. Bring an existing CrewAI project

```bash
keel import crewai ./my_crewai_project --out ported.kir.json
```

Converts `agents.yaml` + `tasks.yaml` to KIR, preserving roles and task→task
dependencies; anything it can't translate is reported, not silently dropped.

---

## 10. Going to production

The same code runs unchanged at scale — swapping a backend is a config line:

- **Durable store**: `pip install 'keel[pg]'` and point the runtime at Postgres
  (`PostgresEventStore`); the executor behaves identically to SQLite.
- **Workers**: `LeasedRunLoop` + a `Scheduler` (in-memory or `keel[nats]` JetStream)
  let any worker resume any run; a stolen lease + `(run_id, seq)` uniqueness mean a
  partition can't corrupt the log.
- **Observability**: `pip install 'keel[otel]'` to export GenAI spans (run→step
  nesting, token/cost attributes) to Datadog / Tempo / Jaeger.
- **Governance**: wire a `PolicyEngine` (RBAC + rules) into the tool gateway —
  enforced at the boundary, not as prompt text — and run tools out-of-process under
  the sandbox.
- **Triggers**: start runs from events with `POST /v1/triggers/<graph>` (HMAC-verified).
  Send a stable `Idempotency-Key` for retryable deliveries: the first request atomically claims a
  deterministic run id, exact replays return that run with `replayed: true`, and reuse with a
  different body fails with `409` instead of executing ambiguous work.
  or a NATS subject.

See the [README](../README.md) for the architecture and the
[`docs/PHASE*_STATUS.md`](.) docs for the full feature map.
