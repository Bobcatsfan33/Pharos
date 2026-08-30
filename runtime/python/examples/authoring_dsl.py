"""OPTIONAL convenience DSL — not the headline.

KEEL's product is durable execution; *how* you author the graph is your choice. This
file shows the bundled L5 ``Agent``/``Task``/``Crew`` sugar, which simply compiles to
the same KIR the executor runs (see ``examples/research_pipeline.py`` for the KIR-first
form, and the framework adapters for running an unmodified LangGraph/CrewAI graph).

    python examples/authoring_dsl.py
    keel run --mock examples/authoring_dsl.py     # exposes `crew`
"""
import asyncio

from keel.authoring import Agent, Task, Crew
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort

researcher = Agent("researcher", goal="Find the key facts on the topic")
writer = Agent("writer", goal="Write a clear, sourced summary from the research")

research = Task("Research the topic thoroughly", agent=researcher)
write = Task("Write the article from the research", agent=writer, context=[research])

crew = Crew("research_pipeline_dsl", tasks=[research, write])


async def main() -> None:
    runner = await Runner.open(in_memory=True, model=MockModelPort(reply='{"summary": "done"}'))
    state = await runner.run(crew.compile(), run_id="dsl-1")
    await runner.close()
    print(f"run {state.run_id} -> {state.status}  (DSL compiled to KIR)")


if __name__ == "__main__":
    asyncio.run(main())
