# Pharos architecture

Pharos is one platform with a single domain model and one event pipeline feeding two
surfaces. The unification is not a merge of dashboards; it is one event pipeline with two
consumers.

## One pipeline, two consumers

```
                 ┌─────────────────────────────────────────────────────┐
   agent action  │  POST /v1/actions  (single ingestion surface)        │
  ───────────────▶                                                       │
                 │   VerdictEngine ─────────────┐                        │
                 │   (Beam / Decide)            │  one transaction       │
                 │                              ▼                        │
                 │   EvidenceStore.append() ── seal ── WORM ── Postgres  │
                 │   (Ledger / Prove)                                    │
                 └───────────────┬───────────────────────┬──────────────┘
                                 │                        │
                       verdict (allow/block/        sealed, chained
                        modify/escalate)            ActionRecord
```

The verdict response and the sealed evidence record are two outputs of the **same
transaction** — an action can never be governed without being recorded, or recorded
without its governing context.

## Packages

| Package | Responsibility |
|---------|----------------|
| `@pharos/core` | Frozen `ActionRecord` schema v1, canonical hashing, sealing, chain verification, KMS signing abstraction (+ local KMS), the Tier-1 verdict engine, legacy migration adapters. Pure, no infra. |
| `@pharos/config` | Fail-fast environment configuration (Zod), one source of truth across all deployment modes. |
| `@pharos/storage` | Postgres (operational state + chain), S3 WORM (evidence), Redis (cache); the transactional write path and the chain-integrity service. |
| `@pharos/api` | Fastify ingestion API + the composition root (`buildPlatform`). |
| `@pharos/console` | Next.js console with the unified Beam (Decide) / Ledger (Prove) information architecture. |

## Storage tiers

- **Postgres** — policies, mandates, tenants, queues, and the authoritative chained
  `action_records`. Per-tenant `tenant_chain_head` serializes appends and holds the head
  hash so each new record links to its predecessor inside one transaction.
- **S3 WORM** (Object Lock, COMPLIANCE mode) — the immutable evidence chain; sealed
  records are content-addressed and cannot be altered before retention expires.
- **Redis** — deadline-bound verdict caches.
- **KMS** — per-environment (Sprint 0) Ed25519 signing keys; rotation with chain
  continuity. Replaced by AWS KMS in production by configuration.

## Deployment modes

The architecture targets SaaS (multi-tenant), dedicated VPC, and customer-hosted
(Compose/Helm). No Sprint-0 decision forecloses customer-hosted: every dependency
(Postgres, Redis, S3-compatible store, KMS) has a self-hostable implementation, and
configuration is the only thing that changes between modes.

## What Sprint 0 deliberately defers

Identity/SSO/RBAC/tenancy isolation (Sprint 1), the real Tier-2/Tier-3 cascade and
measured latency (Sprint 2), SDKs and the gateway (Sprint 3), and everything after. The
verdict engine here is honest Tier-1-only; the cascade interface is shaped so later tiers
slot in behind it.
