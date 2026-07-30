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
  (`fail_closed` → escalate by default). `govern()` uses an atomic claim so concurrent
  callers execute a side effect at most once. Crash-safe exactly-once execution additionally
  requires an idempotent side effect or transactional outbox at the target.
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
escalate         -> await a human verdict, then one caller wins the resume claim
double-resume    -> the tool runs at most once
```

## Workflow continuation (atomic at-most-once claim)

An `escalate` verdict parks the action ([`escalations`](../packages/storage/src/escalationStore.ts))
with full context. A reviewer resolves it (`approve` / `modify` / `reject`), which **seals a
tier-`human` verdict record** linking reviewer identity, rationale, and the overridden
machine context. The agent then resumes via an atomic **claim**: `claimResume` flips
`resumed_at` in one statement, so one resumer wins under concurrent attempts. This is an
at-most-once authorization: a process crash after the claim but before an arbitrary side
effect commits can lose execution. Exactly-once requires an idempotent target or a
transactional outbox. The concurrency property is proven end-to-end in
`test/integration.causeway.test.ts`.

## Zero-code gateway

[`@pharos/gateway`](../services/gateway) governs an agent's HTTP egress with no library
integration — only a base-URL/proxy change. Each outbound request is mapped to an action and
governed: `allow` forwards to the upstream, `block` returns 403 with citations, `escalate`
encrypts the request in a tenant-isolated Postgres store and returns a continuation handle.
`POST /__resume/:id` acquires a bounded lease, claims, and forwards with a stable
`Idempotency-Key`. The production server requires `PHAROS_PG_URL` and
`PHAROS_GATEWAY_HOLD_MASTER_KEY_B64`; it will not silently fall back to memory. The
integration test replaces the gateway between hold and resume and proves the fresh process
can deliver it without exposing plaintext or crossing tenant boundaries.

The production Helm workload adds two replicas minimum, zone spreading, a disruption
budget, stabilized autoscaling, graceful shutdown, and dependency-aware readiness. It uses
a dedicated Secret and ServiceAccount, and a production render is rejected unless ingress,
upstream, and database network allowlists are explicit. Reserved
`/__pharos/healthz` and `/__pharos/readyz` endpoints are never forwarded to the governed
target.

## Mandates

[`MandateStore`](../packages/storage/src/mandateStore.ts) + the Mandate API create, version,
and bind mandates (scope, limits, grantor, expiry). A verdict evaluates the active mandate
version as a Tier-1 input and seals the exact binding into the record — e.g. a $25k mandate
blocks a $30k action at Tier 1 (`test/integration.causeway.test.ts`).

## External gates (not code)

Publishing the SDKs to PyPI/npm and onboarding 3–5 design partners are the remaining
external steps; the packages are versioned and structured for publication, and the conformance
suites gate every build.
