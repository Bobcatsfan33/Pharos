# Framework adapters — be the runtime under the frameworks

Keep the framework you already use; gain durability, tracing, budgets, and
byte-identical replay by running it under KEEL. This is the highest-leverage way to
adopt KEEL: no rewrite of your graph.

## The one conformance contract

Every adapter expresses a framework agent as a graph of `AgentNode`s whose model calls
flow through a `TracedModel`. KEEL's executor drives that graph, so the run is durable
and replayable. A single suite, `keel.adapters.assert_conforms`, checks every adapter:

1. **Recorded** — model calls emit `llm.request`/`llm.response` (tokens + cost).
2. **Budget-governed** — spend is metered at the emit chokepoint.
3. **Replayable** — the recorded run replays **byte-identically**.

```python
from keel.adapters import assert_conforms
from keel.adapters.crewai import reference_agent

report = await assert_conforms("crewai", reference_agent(), model=my_model)
assert report.ok   # recorded calls > 0, byte-identical replay, completed
```

Run your own agent with `keel.adapters.run_agent(...)` — it returns an `AgentRun` you
can crash, resume (`Runner.resume`), and replay (`replay_agent`).

## The interception point

`TracedModel` is what a framework node calls instead of its own LLM client. Each call
is recorded, budgeted, and — on resume — replayed from the effect ledger (not re-issued,
not re-billed). That is the whole adapter: route model (and tool) calls through KEEL.

## Adapters and their boundaries

| Adapter | Module | Live integration | What's intercepted | What's **not** (yet) |
|---------|--------|------------------|--------------------|----------------------|
| **CrewAI** | `keel.adapters.crewai` | `run_crew(agents, tasks, model=…)` — executes a crew live (the Phase-4 importer's next step) | each task's model calls, task→task dependencies | a custom Python tool's internal nondeterminism unless run through KEEL's tool gateway |
| **LangGraph / LangChain** | `keel.adapters.langgraph` | `run_graph(node_fns, edges, model=…)`; `keel_chat_model()` (a `BaseChatModel`, needs `keel[langchain]`) | model calls made through the provided model; node graph as KIR | framework-internal control flow / state reducers KEEL doesn't drive |
| **OpenAI Agents SDK** | `keel.adapters.sdk_agents` | `run_openai_agent(agent, model=…)` (needs `keel[openai]`) | the agentic loop's model turns + tool calls routed through KEEL | SDK-side tool execution not routed through the gateway |
| **Anthropic SDK** | `keel.adapters.sdk_agents` | `run_anthropic_agent(system, tools, model=…)` (needs `keel[anthropic]`) | tool-use turns | same as above |
| **Pydantic-AI** | `keel.adapters.pydantic_ai` | `run_pydantic_agent(agent, model=…)` (needs `keel[pydantic-ai]`) | the typed agent's model turns | validation/retry the framework runs out of band |

Each adapter ships a SDK-free `reference_agent()` that is a real, runnable KEEL agent in
that framework's shape — these are what the conformance suite proves in CI
(`tests/unit/test_adapters.py`). The live SDK entry points are guarded behind the
optional extras and run if the SDK is installed.

**Want to add one?** See [`docs/ADAPTER-AUTHORS.md`](ADAPTER-AUTHORS.md) — the
`pydantic-ai` adapter is the worked example of the (small, well-scoped) contribution.

> **Honesty boundary.** KEEL intercepts what flows through `TracedModel` and the tool
> gateway. Anything a framework does out of band — a node that reads the clock, a tool
> that hits the network without going through the gateway — is invisible to replay. Keep
> node functions deterministic-given-model-output (the determinism contract applies at
> the integration layer too).

## Bring your own framework

Any agent you can express as "nodes that call a model, with dependencies" runs under
KEEL:

```python
from keel.adapters import AgentNode, run_agent

async def research(model, inputs):
    return (await model.complete([{"role": "user", "content": "research the topic"}])).encode()

async def write(model, inputs):
    ctx = b"".join(inputs.values()).decode()
    return (await model.complete([{"role": "user", "content": f"write from: {ctx}"}])).encode()

run = await run_agent("my_agent",
    [AgentNode("research", research), AgentNode("write", write, deps=["research"])],
    model=my_model)
# durable, traced, budgeted, replayable — no KEEL DSL required
```
