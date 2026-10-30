# Architecture

Pharos is one product with two halves. A TypeScript **control plane** decides and seals: every
consequential agent action is submitted before it executes, receives a verdict, and is
recorded as signed, chained evidence in the same transaction. A Python **runtime** executes
under it: each durable step is submitted through the control plane, escalation is a
zero-compute pause, and a run resumes after a crash and replays byte-identically.

This document is the map: the data model, the layers, the pipeline, and the extension points.
How to *add* something is in [`CONTRIBUTING.md`](../CONTRIBUTING.md#where-a-change-goes).

## One pipeline, two consumers

```
                 ┌──────────────────────────────────────────────────────┐
   agent action  │  POST /v1/actions   (single ingestion surface)        │
  ───────────────▶                                                        │
                 │   VerdictCascade  Tier 1 ─▶ Tier 2 ─▶ Tier 3 panel     │
                 │   (Decide)                      │                      │
                 │                                 ▼   one transaction    │
                 │   EvidenceStore.append() ── seal ── Postgres ── WORM   │
                 │   (Prove)                                              │
                 └───────────────┬────────────────────────┬──────────────┘
                                 │                         │
                       verdict (allow / block /      sealed, chained
                        modify / escalate)           ActionRecord
```

The verdict and the sealed record are two outputs of the **same database transaction**. A
KMS, Postgres or WORM failure at seal time fails the whole call (503) rather than returning a
verdict that was never recorded; the SDKs then apply a local fail-mode — reversible work fails
open into async review, irreversible work fails closed to a human.

## The data model

One event type carries everything: the **`ActionRecord`** (`@pharos/core`,
[schema-v1.md](schema-v1.md)). Its `content` — the action, the verdict context, the liability
context (mandate, blast radius, oversight mode, model metadata), tenant, sequence and
timestamp — is canonicalised, hashed and signed; its `seal` carries the content hash, the
previous record's hash, the key id and the signature. Records chain per tenant from a genesis
hash to a head; chain heads are periodically anchored to a trusted-time authority.

The vocabulary the record shares with the outside world — decisions, reversibility,
oversight modes, fail modes, tiers, rule citations — is defined once, in
**`@getpharos/pdp-spec`**, as zod schemas published as [JSON Schema](spec/pdp-v1.md). The
record schema, both SDKs' types and the open PDP contract are composed of or generated from
those definitions; a test fails when any copy drifts.

## Layers

```
           services/api  (composition root)      services/gateway      apps/console
                  │                                      │
  ┌───────────────┴──────────────────────────────────────┴─────────────────────┐
  │ cascade                                                                     │
  ├─────────┬──────────┬──────────┬──────────┬────────────┬─────────┬──────────┤
  │ policy  │  judge   │ evidence │ storage  │ connectors │ review  │ identity │  …
  ├─────────┴──────────┴──────────┴──────────┴────────────┴─────────┴──────────┤
  │ core  ──  ActionRecord, canonical hashing, sealing, chain verify, signing   │
  ├────────────────────────────────────────────────────────────────────────────┤
  │ pdp-spec  ──  the wire contract (zod + JSON Schema)                         │
  └────────────────────────────────────────────────────────────────────────────┘
```

Dependencies point downward only. `core` is pure — no database, no network — which is what
makes offline verification possible: `pnpm verify:bundle` runs on `core` alone.

| Package | Responsibility |
|---|---|
| `@getpharos/pdp-spec` | The open PDP contract: zod schemas, published JSON Schema, a conformance suite, an independent reference implementation. |
| `@pharos/core` | `ActionRecord` v1 (frozen), canonical JSON, sealing, chain verification, the `SigningProvider` interface and the signing-provider registry (`local-kms`, `aws-kms`, `RemoteKms` for Vault / Azure / GCP), redaction, the Tier-1 verdict engine. |
| `@pharos/config` | Fail-fast environment configuration (zod); rendered once and passed down, never read at the point of use. Production posture is enforced here. |
| `@pharos/policy` | The declarative rule model, the rule evaluator, the constrained-grammar compiler, OPA / Cedar interchange, signed policy bundles, and the shipped packs discovered from `packs/*.json`. |
| `@pharos/judge` | The judge contract, the structural judge, the linear and ONNX content judges, the judge panel, the model registry, the judge-provider registry and the served-model manifest. |
| `@pharos/judge-eval` | Eval datasets, metrics with confidence intervals, the leakage and regression gates. |
| `@pharos/cascade` | Tier 1 → Tier 2 → Tier 3 under a deadline, routing, fail modes, replay fingerprints. |
| `@pharos/evidence` | Trusted-time anchoring (TSA-provider registry: `local`, `rfc3161`), claims packs, regulatory exports. |
| `@pharos/storage` | Postgres (operational state and the chain, RLS-isolated), S3 Object Lock WORM, Redis cache, migrations, the transactional write path, chain-integrity checks. |
| `@pharos/identity` | OIDC verification, API keys, deny-by-default RBAC. |
| `@pharos/connectors` | MCP registry and governance, credential grants, governed effects, connector-plugin conformance. |
| `@pharos/review` | Review queues, approval policy, routing, disagreement capture. |
| `@pharos/assurance` | Sampling-based assurance with Wilson bounds, risk profile, readiness checks, the underwriter feed. |
| `@pharos/observability` | Prometheus metrics, tracing, OCSF export, judge drift monitoring, the causal evidence graph. |
| `@pharos/billing`, `@pharos/devkit` | Metering and the policy workbench. |
| `@pharos/middleware`, `@getpharos/sdk`, `getpharos` (Python) | Framework adapters and the two SDKs, sharing one conformance contract. |
| `services/api` | The Fastify ingestion API and the composition root, `platform.ts`, which builds everything from configuration by name. |
| `services/gateway` | The zero-code HTTP egress gateway: governs an agent that imports nothing; durable, encrypted held requests; exactly-once resume. |
| `runtime/python` | Pharos Runtime: event-sourced durable execution, the `pharos` CLI and viewer, framework adapters; talks to the control plane through the Python SDK. |
| `apps/console` | The Next.js console. |

## The decision cascade

**Tier 1** is deterministic: mandate scope and limits, pack rules over action fields. It
short-circuits most actions. **Tier 2** scores statistical risk. **Tier 3** is a panel of
typed judges: a model-free **structural judge** (mandate scope, payload schema, plan
conformance, blast-radius consistency) runs on every action; **content judges** run only for
the action types their pack binding declares, so a `crm.update` never wakes a FINRA model.
Applicable judges run concurrently under the cascade deadline, so the tier costs the slowest
judge, not the sum, and each judge's wall time is sealed into the record
(`verdict.latency.perTier["3/<judgeId>"]`). [decision-cascade.md](decision-cascade.md) has
the semantics; [benchmarks/latency.md](benchmarks/latency.md) the numbers.

Every signal that influences a verdict is sealed with a content-hashed version
(`judgeVersion`: artifact hash plus runtime identity), so a verdict can be replayed against
the exact judge that produced it.

## Storage and trust

- **Postgres** — policies, mandates, tenants, queues, escalations, and the authoritative
  chained `action_records`. A per-tenant chain head serialises appends so each record links to
  its predecessor inside one transaction. Row-level security under a `NOBYPASSRLS` role.
- **S3 Object Lock (COMPLIANCE mode)** — the immutable evidence chain. A reconciler flags
  objects written to WORM but never committed to Postgres.
- **Redis** — deadline-bound verdict caches and rate limits; best-effort, never authoritative.
- **Signing** — a `SigningProvider` with rotation and chain continuity. Development uses a
  passphrase-encrypted local Ed25519 keystore; production requires AWS KMS (ECDSA P-256), with
  Vault Transit, Azure Key Vault and GCP KMS available through `RemoteKms`. The seal path is
  wrapped in a circuit breaker: a KMS outage fails the seal, never queues a "sign later".
- **Trusted time** — chain heads are anchored on a schedule. Development uses a simulated
  local TSA with its own keys; production requires a real RFC 3161 authority with an
  independently supplied certificate pin.
- **TLS** — terminated in front of Pharos by the host (ingress, mesh or load balancer); the
  Helm chart refuses to render production without a declared terminator.

## Extension points

Every extensible concern has one interface and one registry; the composition root resolves
implementations by name from configuration.

| Concern | Interface | Registry | Selected by |
|---|---|---|---|
| Signing backend | `SigningProvider` (`@pharos/core`) | `registerSigningProvider` | `PHAROS_KMS_PROVIDER` |
| Trusted-time backend | `TsaProvider` (`@pharos/evidence`) | `registerTsaProvider` | `PHAROS_TSA_PROVIDER` |
| Judge serving | `ModelRegistry` factory (`@pharos/judge`) | `registerJudgeProvider` | `PHAROS_JUDGE_PROVIDER` |
| Served judge models | — | `packages/judge/models/manifest.json` | the manifest |
| Policy packs and judge bindings | `PolicyArtifact` + `judgeBindings` | `packages/policy/packs/*.json`, discovered | the directory |
| Framework middleware | `govern` wrapper (`@getpharos/middleware`) | conformance suite | import |
| Governed connector | `ConnectorPlugin` (`@pharos/connectors`) | `runPluginConformance` | configuration |
| Runtime framework adapter | adapter module (`keel/adapters`) | adapter conformance suite | import |

`test/registries.extension.test.ts` pins the contract: a new backend is one file plus one
register call, and a new pack is one file.

## Deployment

Customer-hosted by design. Every dependency — Postgres, Redis, an S3-compatible store, a KMS,
a TSA — has a self-hostable implementation, and configuration is the only thing that changes
between a laptop, a VPC and a regulated on-premises deployment. Docker Compose and a Helm
chart are in [`deploy/`](../deploy/INSTALL.md); the production posture (AWS KMS, RFC 3161,
ONNX judges, a declared TLS terminator) is enforced by `@pharos/config` at boot.
