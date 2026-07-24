# SDKs, middlewares, and the gateway (Sprint 3 — Causeway)

Until a customer's agent can be governed without rewriting it, Pharos has no path into
production. Causeway delivers the adoption surface: SDKs, framework middlewares, a no-code
gateway, programmatic mandates, and — critically — **workflow continuation** so an escalated
action resumes after a human verdict instead of stranding the agent.

## One ingestion shape

```
POST /v1/actions  { tenantId, action, liability, mandateId?, idempotencyKey? }
  -> { verdict, record, escalation }
```

`mandateId` binds a stored mandate (resolved server-side, sealed into the record).
`escalation` is non-null when the verdict is `escalate` — the handle for continuation.

## SDKs

- **TypeScript** — [`@getpharos/sdk`](../packages/sdk-ts) (`PharosClient`): deadline-aware
  (aborts at the budget), retries transient failures (not 4xx), structured errors, telemetry
  hooks, and a safe **local fail-mode default** when the platform is unreachable
  (`fail_closed` → escalate by default). `govern()` runs a side effect end-to-end with
  exactly-once semantics.
- **Python** — [`getpharos`](../sdks/python) (`PharosClient`): the same contract, stdlib-only.

## Framework middlewares (one conformance contract)

Every middleware delegates to a single `governTool` (TS) / `govern_tool` (Python) so they
share identical semantics and pass one conformance suite:

| Framework | Package | Adapter |
|-----------|---------|---------|
| LangChain / LangGraph | `@getpharos/middleware` | `langchainTool`, `langgraphNode` |
| OpenAI Agents SDK | `@getpharos/middleware` | `openaiAgentTool` |
| Anthropic SDK (tool_use) | `@getpharos/middleware` | `anthropicToolHandlers` |
| CrewAI | `getpharos` | `crewai_tool` |
| Microsoft Agent Framework | `getpharos` | `ms_agent_tool` |

Contract (proven in `test/middleware.conformance.test.ts` and
`sdks/python/tests/test_conformance.py`):

```
allow / modify   -> run the tool
block / reject   -> raise/throw PharosBlockedError (the tool never runs)
escalate         -> await a human verdict, then resume exactly once
double-resume    -> the tool runs at most once
```

## Workflow continuation (exactly-once)

An `escalate` verdict parks the action ([`escalations`](../packages/storage/src/escalationStore.ts))
with full context. A reviewer resolves it (`approve` / `modify` / `reject`), which **seals a
tier-`human` verdict record** linking reviewer identity, rationale, and the overridden
machine context. The agent then resumes via an atomic **claim**: `claimResume` flips
`resumed_at` in one statement, so exactly one resumer wins even under concurrent or retried
resumes. Proven end-to-end in `test/integration.causeway.test.ts`.

## Zero-code gateway

[`@pharos/gateway`](../services/gateway) governs an agent's HTTP egress with no library
integration — only a base-URL/proxy change. Each outbound request is mapped to an action and
governed: `allow` forwards to the upstream, `block` returns 403 with citations, `escalate`
holds the request and returns a continuation handle; `POST /__resume/:id` claims (exactly
once) and forwards. An **unmodified agent** (no Pharos imports) is governed end-to-end in
`test/integration.gateway.test.ts`.

## Mandates

[`MandateStore`](../packages/storage/src/mandateStore.ts) + the Mandate API create, version,
and bind mandates (scope, limits, grantor, expiry). A verdict evaluates the active mandate
version as a Tier-1 input and seals the exact binding into the record — e.g. a $25k mandate
blocks a $30k action at Tier 1 (`test/integration.causeway.test.ts`).

## External gates (not code)

Publishing the SDKs to PyPI/npm and onboarding 3–5 design partners are the remaining
external steps; the packages are versioned and structured for publication, and the conformance
suites gate every build.
