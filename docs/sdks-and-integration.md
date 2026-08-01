# SDKs, middlewares, and the gateway (Sprint 3 — Causeway)

Until a customer's agent can be governed without rewriting it, Pharos has no path into
production. Causeway delivers the adoption surface: SDKs, framework middlewares, a no-code
gateway, programmatic mandates, and — critically — **workflow continuation** so an escalated
action resumes after a human verdict instead of stranding the agent.

## One ingestion shape

```
POST /v1/actions  { tenantId, action, liability, mandateId?, idempotencyKey? }
  -> 201 { verdict, record, escalation, replayed: false }   // sealed a new record
  -> 200 { verdict, record, escalation, replayed: true  }   // replay; nothing created
  -> 409 { error: { code: "idempotency_key_reuse" } }       // key re-used for another request
```

`mandateId` binds a stored mandate (resolved server-side, sealed into the record).
`escalation` is non-null when the verdict is `escalate` — the handle for continuation.

### `idempotencyKey` — exactly-once ingest

Delivery to the ingest path is at-least-once in practice: SDKs retry, proxies retry, queues
redeliver. Because the ledger is append-only, each redelivery would otherwise seal another
valid, signed record, and nothing downstream could distinguish *"the agent acted twice"* from
*"the network retried once"*.

Supplying `idempotencyKey` makes ingest exactly-once for that request. The claim on the key
commits in the **same transaction** as the append, so there is no window in which a record
exists without its claim (a replay would seal a second record) or a claim exists without its
record (a replay would resolve to nothing). Redeliveries — including concurrent ones — return
the original record with `replayed: true` and HTTP `200`, and report the same `escalation`.

The key binds one exact request: a fingerprint over `tenantId`, `action`, `liability`, and
`mandateId`. `action.emittedAt` is deliberately excluded, since a client that re-stamps the
timestamp on retry is still redelivering the same action. Re-using a key for a *materially
different* request is refused with `409 idempotency_key_reuse` rather than collapsed —
answering with an unrelated sealed record would misreport what was governed.

Keys are scoped per tenant. The guard is **opt-in**: a client that sends no key keeps the
prior at-least-once behavior.

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
an explicit versioned encryption key ring; it will not silently fall back to memory. Each
ciphertext stores its key id, and a bounded, row-locked migration re-encrypts pending rows
under a newly active key without stopping delivery. The integration test replaces the
gateway between hold and resume, rotates a retained request online, and proves a fresh
process can deliver it without exposing plaintext or crossing tenant boundaries.

Production also requires `GATEWAY_IDEMPOTENCY_PROBE_PATH`. Before listening, the gateway
posts the same unique body and `Idempotency-Key` twice to
`{GATEWAY_TARGET}{GATEWAY_IDEMPOTENCY_PROBE_PATH}`. A conforming endpoint returns HTTP 200
with `{ protocol: "pharos-idempotency-conformance-v1", idempotencyKey, executions: 1,
resultId }` on both attempts, the same non-empty `resultId`, and
`X-Idempotency-Replayed: true` only on the second. The probe endpoint must share the
governed routes' durable deduplication store; otherwise it proves only itself.

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
