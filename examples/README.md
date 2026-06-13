# Pharos reference agents

Runnable references showing how agents are governed by Pharos.

## `langgraph-agent.ts` — SDK + middleware

A LangGraph-style workflow whose tool step is governed via `@pharos/middleware`'s
`langgraphNode`. Shows allow → blocked → escalate→resume. Run:

```bash
pnpm infra:up && pnpm api:dev
# provision a tenant + key (returns adminKey.plaintext)
curl -sXPOST localhost:4000/v1/admin/tenants -H "x-pharos-admin: $PHAROS_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"tenantId":"acme","displayName":"Acme"}'
PHAROS_API_KEY=<key> PHAROS_TENANT=acme pnpm tsx examples/langgraph-agent.ts
```

The other framework middlewares (OpenAI Agents, Anthropic SDK, CrewAI, MS Agent
Framework) follow the same shape — see the conformance suites
(`test/middleware.conformance.test.ts`, `sdks/python/tests/test_conformance.py`).

## Unmodified agent via the gateway — zero code change

An agent that imports **no Pharos SDK** is governed purely by routing its HTTP egress
through the gateway (`@pharos/gateway`). It acts, gets blocked, gets escalated, receives a
human verdict, and resumes exactly once. The full flow is exercised in
`test/integration.gateway.test.ts`; to run a gateway yourself:

```bash
# point the gateway at your real upstream; the agent points at the gateway
pnpm --filter @pharos/gateway dev   # reads PHAROS_* + GATEWAY_TARGET from .env
```
