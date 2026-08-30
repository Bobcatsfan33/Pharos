# KEEL — Durable execution for LLM agents

[![CI](https://github.com/Bobcatsfan33/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/Bobcatsfan33/keel/actions/workflows/ci.yml)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-green.svg)](LICENSE)
[![Typed: mypy --strict](https://img.shields.io/badge/mypy-strict-blue.svg)](https://mypy-lang.org/)
[![Lint: Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![Layers: import-linter](https://img.shields.io/badge/layers-import--linter-blueviolet.svg)](https://import-linter.readthedocs.io/)

**A run is an append-only event log.** Any run resumes after a crash from its last
completed step, replays byte-identically, and never re-bills a completed model call.
**Bring your own framework** — KEEL is the runtime that makes it survive production.

KEEL is to LLM agents what Temporal / Inngest / DBOS are to ordinary services:
durable execution. The difference is the LLM-specific hard parts those tools don't
address — non-deterministic model calls, token-metered cost, streaming, tool side
effects, and human-in-the-loop gates — made to work *inside* a deterministic replay
model.

> **Project status.** Early-stage, single-maintainer project. The runtime is
> functional and every PR is CI-gated, but it has **not** had an independent security
> audit, a live multi-node soak test, or production deployments. See
> [`docs/WHEN-NOT-TO-USE.md`](docs/WHEN-NOT-TO-USE.md) for honest non-fit cases and
> maturity. Every capability claim below is backed by a test or benchmark in CI; if it
> isn't proven, it isn't claimed.

## See it (no API key, under 2 minutes)

```console
$ pip install keel
$ python -m examples.crash_resume_demo

KEEL — crash/resume signature demo

  clean run cost ............. $0.001000
  crashed after 'research' commits (a kill before step.completed)
  resumed in a fresh runtime: 3 model calls on resume (research replayed from the log, not re-issued)
  cost after resume .......... $0.001000

  cost-of-resume == clean-run cost?  PASS ✅
  (the completed model call was replayed from the log and never re-billed)
```

A 4-step agent makes billed model calls, "crashes" mid-run, and resumes in a fresh
runtime — the completed call is replayed from the log (cost unchanged) and only the
remaining work executes. The cost equality is a **checked assertion**, gated in CI
(`tests/chaos/test_crash_resume_demo.py`), not a screenshot. Browse the same run in the
viewer: `keel view`.

## The two capabilities

1. **Durability you can see.** Kill the process mid-run and resume in a fresh process:
   completed model/tool calls are replayed from the log (cost unchanged) and only the
   remaining work executes. Replay is byte-identical for the recorded run.
2. **Any recorded run is a regression test.** `keel regress record` freezes a run into a
   self-contained bundle (graph + event log + blobs); a GitHub Action replays it
   byte-identically on every PR — with no API key — and blocks the merge on determinism
   or behavioural drift. KEEL dogfoods this on its own runs. See
   [docs/REGRESSION.md](docs/REGRESSION.md).

Supporting features — explicit per-run **budgets**, **OTel** GenAI export, an
**out-of-process tool sandbox**, **policy + RBAC**, and a **hash-chained audit
log** — exist because a runtime in the execution path needs them, not as headliners.

## Governed execution with Pharos

[Pharos](https://github.com/Bobcatsfan33/Pharos) is the governance and sealed-evidence
plane built into Keel's durable step boundary. Enable it once and every runnable step is
authorized before `step.started`; allow/modify continues, block fails without executing,
and escalation parks the run until a human decision is available. A stable action key and
resume claim make the whole path crash-safe.

```bash
export PHAROS_URL=http://localhost:4000
export PHAROS_API_KEY=pk_...
export PHAROS_TENANT_ID=acme

keel run --mock examples/pharos_governed.py --run-id governed-demo
# The example's synthetic sensitive publication escalates. Approve it in Pharos, then:
keel resume governed-demo --mock
```

Pharos seals the authorization; Keel appends its evidence binding directly before the
step lifecycle, joining the verdict to the eventual execution outcome in one ordered log.
The integration is fail-closed by default. See [the full contract and setup](docs/PHAROS.md).

## How it works

```
L4  KIR — the intermediate representation the executor runs (graphs of typed nodes)
L3  Services — model router, budgeter, tool gateway, eval harness, policy engine
L2  Durable Executor — event-sourced state machine; resume == normal scheduling
L1  Substrate — trace bus, storage adapters, OTel export, and the clock/id/rng/model/
                tool *ports* through which all nondeterminism flows (record + replay)
```

Current state is a pure fold over the event log. Resume after a crash and normal
scheduling are the **same code path** — fold the log, compute the runnable frontier,
schedule it. Every nondeterminism source is funnelled through an L1 port that records
live and replays deterministically; the exact guarantees (and their current limits)
are the written contract in [`docs/DETERMINISM.md`](docs/DETERMINISM.md).

> The L5 `Agent`/`Task`/`Crew` DSL is an **optional convenience**, not the product —
> it compiles to KIR like anything else. The headline path is KIR or a framework
> adapter. See [`examples/authoring_dsl.py`](examples/authoring_dsl.py).

## Quickstart (no API key, under 2 minutes)

```bash
pip install keel            # SQLite + content-addressed blobs, zero extra services
pip install 'keel[viewer]'  # adds the local trace viewer

keel run --mock examples/research_pipeline.py   # durable, traced, budgeted — no key
keel ls                                         # list runs
keel show <run_id>                              # the full event timeline (the trace)
keel view                                       # the dashboard: runs/steps/prompts/tokens/$
```

The dashboard is a single-file SPA (no build step) styled like macOS and laid out
like Kibana Discover: an **Overview** with KPI cards and inline charts, a faceted
**Discover** event explorer (filter by type/node, full-text, histogram, payload
drill-down), a **Costs** rollup, and inline gate approve/reject. Light/dark follows
the OS.

The example is plain **KIR** — a graph of typed nodes, the thing the executor runs:

```python
from keel.kir.schema import Graph, Node, Edge, NodeType

graph = Graph(
    graph_id="research_pipeline",
    nodes=[
        Node(id="research", type=NodeType.LLM_STEP,
             config={"model": "anthropic:claude-haiku-4-5", "prompt": "Research the topic."}),
        Node(id="write", type=NodeType.LLM_STEP,
             config={"model": "anthropic:claude-haiku-4-5", "prompt": "Write it up."}),
    ],
    edges=[Edge.model_validate({"from": "research", "to": "write"})],
)
```

**→ Full tour:** the [quickstart walkthrough](docs/QUICKSTART.md) — run, pause at a
human gate, resume in a fresh process, budget it, replay it byte-identically, and turn
the run into a regression test.

## Bring your own framework

Keep LangGraph / CrewAI / Pydantic-AI / the OpenAI Agents SDK / the Anthropic SDK — gain
durability, tracing, budgets, and byte-identical replay by running it *under* KEEL.
Adapters route the framework's model and tool calls through KEEL; no graph rewrite. One
conformance suite covers them all (`docs/ADAPTERS.md`), and adding a new one is a small,
well-scoped contribution (`docs/ADAPTER-AUTHORS.md`):

```python
from keel.adapters import run_agent, AgentNode

async def research(model, inputs):
    return (await model.complete([{"role": "user", "content": "research"}])).encode()
async def write(model, inputs):
    return (await model.complete([{"role": "user", "content": "write it up"}])).encode()

run = await run_agent("agent",
    [AgentNode("research", research), AgentNode("write", write, deps=["research"])],
    model=my_model)        # durable, traced, budgeted, replayable
```

## Durability you can see

```bash
keel run --mock examples/research_pipeline.py --run-id demo
keel replay demo                          # re-drive from the log: byte-identical
keel diff demo other                      # where two runs diverge (route/cost/payload)
```

Resume and normal scheduling are the *same* fold over the log; completed model calls
are replayed and **never re-billed** (asserted in CI, not screenshotted).

## CLI

`keel run | ls | show | resume | approve | replay | diff | simulate | test | audit | migrate | import | view`

## Container

A first-party **distroless, non-root** image (runner + viewer), signed and
SBOM-attested via the org security workflow:

```bash
docker build -t keel:local .                       # ~140 MB, runs as UID 65532
docker run --rm keel:local run --mock examples/research_pipeline.py
docker run --rm -p 8321:8321 keel:local            # viewer on :8321 (default CMD)
```

Run state goes to the `/data` volume (`KEEL_DATA_DIR`). Published images are at
`ghcr.io/bobcatsfan33/keel`; verify with `cosign verify
--certificate-identity-regexp 'github.com/Bobcatsfan33' …`.

## Where this is going

The product is the substrate (L1/L2): determinism and durability. Frameworks are
distribution, not competition — KEEL aims to run *underneath* LangGraph, CrewAI, the
OpenAI Agents SDK, and the Anthropic SDK. The strategy, milestones, and per-milestone
proof are in [`docs/STRATEGY.md`](docs/STRATEGY.md); the determinism contract is
[`docs/DETERMINISM.md`](docs/DETERMINISM.md); reproducible numbers are in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

CI gates every PR on `ruff` + `mypy --strict` + `import-linter` layers +
unit/property/chaos tests + a nondeterminism lint gate + trace-overhead, viewer-render,
and latency-percentile (p50/p95/p99) benchmarks + a multi-worker crash soak (0 re-bills)
+ byte-identical [regression replay](docs/REGRESSION.md). Apache-2.0.

## Contributing & longevity

Contributions are welcome — start with [`CONTRIBUTING.md`](CONTRIBUTING.md). Adding a
framework adapter is the most welcome and best-scoped contribution
([`docs/ADAPTER-AUTHORS.md`](docs/ADAPTER-AUTHORS.md)). See
[`GOVERNANCE.md`](GOVERNANCE.md) for how decisions are made and how to become a
maintainer, [`SECURITY.md`](SECURITY.md) to report a vulnerability, and
[`docs/STABILITY.md`](docs/STABILITY.md) for the stable-surface and schema-evolution
guarantees (a run recorded on schema *n* replays on *n+1*, gated by the golden corpus).
