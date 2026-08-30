---
name: Framework adapter
about: Request or propose running another agent framework under KEEL
title: "adapter: "
labels: adapter, enhancement
---

## Framework

<!-- Which framework (LangGraph, CrewAI, Pydantic-AI, smolagents, …) and a link. -->

## How its agents call the model

<!-- KEEL intercepts at the model boundary. Describe how this framework issues model
calls — there must be a seam where a model/client can be injected, so calls flow through
KEEL's TracedModel. -->

## Are you up for contributing it?

<!-- Adding an adapter is well-scoped and documented in docs/ADAPTER-AUTHORS.md: a
guarded SDK entry point + an SDK-free reference_agent wired into the conformance suite.
We're happy to guide. -->

- [ ] I'd like to contribute this adapter
- [ ] I'm requesting it
