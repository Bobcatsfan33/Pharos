# Writing a KEEL adapter

An adapter runs an existing agent framework *under* KEEL, so an unmodified agent gets
durability, tracing, budgets, and byte-identical replay. This is the most welcome kind
of contribution, and it touches only the stable adapter contract — never the substrate —
so it's also the recommended path toward becoming a maintainer (`GOVERNANCE.md`).

This guide walks the exact, mechanical steps. The `pydantic-ai` adapter
(`keel/adapters/pydantic_ai.py`) is the worked example — read it alongside this.

## The model

An adapter expresses a framework agent as a small graph of `AgentNode`s. The one rule:
**every model call goes through the `TracedModel` KEEL hands your node.** That is the
interception point that makes the turn recorded, budgeted, and replayable. Control flow
the framework runs out of band is not intercepted unless you route it through KEEL.

```python
from keel.adapters.base import AgentNode, TracedModel

async def step(m: TracedModel, inputs: dict[str, bytes]) -> bytes:
    text = await m.complete([{"role": "user", "content": "..."}])  # recorded + billed
    return text.encode()

nodes = [AgentNode("step", step)]              # add deps=[...] to chain nodes
```

`inputs` maps each upstream node id to its output bytes. Declare edges with
`AgentNode(id, fn, deps=["upstream"])`.

## The two entry points (the convention every adapter follows)

1. **A guarded, SDK-specific entry point** — e.g. `run_<framework>_agent(agent, *,
   model, run_id=None)` — that translates a real framework object into `AgentNode`s and
   calls `run_agent(...)`. Keep the heavy framework import *inside* the function (or
   behind `TYPE_CHECKING`/`Any`) so the core install stays lean; gate it behind an
   optional extra in `pyproject.toml`.
2. **An SDK-free `reference_agent() -> list[AgentNode]`** — a runnable agent shaped like
   the framework's, with no third-party import. This is what proves conformance in CI
   without installing the framework.

## Prove it conforms

The shared conformance suite is the bar. It runs your reference agent under KEEL,
records it, and asserts it completes, makes recorded model calls, and **replays
byte-identically**:

```python
from keel.adapters import assert_conforms
report = await assert_conforms("my_framework", reference_agent(),
                               model=MockModelPort(), price_table=PRICES)
assert report.completed and report.recorded_calls > 0 and report.replay_identical
```

Wire your `reference_agent` into the parametrized suite in `tests/unit/test_adapters.py`
(add it to the `ADAPTERS` dict). That single line is what makes your adapter a
first-class, CI-gated citizen.

## Checklist for an adapter PR

- [ ] `keel/adapters/<framework>.py` with `run_<framework>_agent(...)` (guarded) and
      `reference_agent()` (SDK-free).
- [ ] Added to `ADAPTERS` in `tests/unit/test_adapters.py` — conformance passes.
- [ ] Optional extra in `pyproject.toml` (`<framework> = [...]`), and a mypy override if
      the SDK is untyped.
- [ ] A line in `docs/ADAPTERS.md`.
- [ ] All gates green (`CONTRIBUTING.md`).

That's the whole contribution. No substrate changes, no new guarantees to prove from
scratch — you inherit determinism and durability by construction, and the conformance
suite is your proof.
