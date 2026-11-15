# Pharos reference agents

Runnable references showing how agents are governed by Pharos.

## `langgraph-agent.ts` — SDK + middleware

A LangGraph-style workflow whose tool step is governed via `@getpharos/middleware`'s
`langgraphNode`. Shows allow → blocked → escalate→resume. Run:

```bash
pnpm infra:up && pnpm api:dev
# provision a tenant + key (returns adminKey.plaintext)
curl -sXPOST localhost:4000/v1/admin/tenants -H "x-pharos-admin: $PHAROS_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"tenantId":"acme","displayName":"Acme"}'
PHAROS_API_KEY=<key> PHAROS_TENANT=acme pnpm tsx examples/langgraph-agent.ts
```

## `openai-agents.ts` — OpenAI Agents SDK

Two tools wrapped with `openaiAgentTool`, which returns the `{ name, parameters, execute }`
shape the Agents SDK expects, so the tool can be handed to an `Agent` unchanged. The example
calls `execute` directly, so it needs no OpenAI key and no network.

Shows both sides of a decision, and **per-tool risk mapping**: `mapAction` derives the declared
blast radius from the arguments, so a larger transfer really is a larger declared risk.

```bash
PHAROS_API_KEY=<key> PHAROS_TENANT=acme pnpm tsx examples/openai-agents.ts
```

Observed against a local `pnpm api:dev`: `crm.read` executes; both `payment.transfer` attempts
are **held for a human**, because the shipped `core` pack binds the funds-movement judge with
`requireNoMandate` — pass `mandateId` in `mapAction` once a mandate is provisioned and a
within-limit transfer is allowed instead.

## `anthropic-agent.ts` — Anthropic SDK `tool_use`

`anthropicToolHandlers` wraps a map of tool handlers, so each `tool_use` block is governed
before its handler runs. The wrapped map has the same shape you already dispatch on, so
adoption is one call at the boundary. The example dispatches recorded `tool_use` blocks, so it
needs no Anthropic key and no network.

```bash
PHAROS_API_KEY=<key> PHAROS_TENANT=acme pnpm tsx examples/anthropic-agent.ts
```

Worth knowing, and the example says so: this adapter takes only a tenant and an agent — there
is no per-tool `mapAction` — so every tool is governed under one default liability
(`human_in_loop`, irreversible, blast radius **zero**). Tier 1's irreversible-oversight rule
requires a non-zero amount, so both dispatches are allowed and sealed rather than held. For
per-tool risk, use `governTool` with a `mapAction`, as `openai-agents.ts` does.

The remaining middlewares (CrewAI, MS Agent Framework) follow the same shape — see the
conformance suites (`test/middleware.conformance.test.ts`,
`sdks/python/tests/test_conformance.py`).

## Unmodified agent via the gateway — zero code change

An agent that imports **no Pharos SDK** is governed purely by routing its HTTP egress
through the gateway (`@pharos/gateway`). It acts, gets blocked, gets escalated, receives a
human verdict, and resumes exactly once. The full flow is exercised in
`test/integration.gateway.test.ts`; to run a gateway yourself:

```bash
# point the gateway at your real upstream; the agent points at the gateway
pnpm --filter @pharos/gateway dev   # reads PHAROS_* + GATEWAY_TARGET from .env
```
