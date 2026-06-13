# Pharos

**The trust control plane for enterprise AI agents.**

*Pharos decides. Pharos proves.*

---

Pharos governs every consequential AI-agent action twice. **Once before it happens** — a real-time policy verdict (allow, block, modify, escalate) issued through a tiered decision cascade under a hard latency budget. **Once after** — a tamper-evident, cryptographically signed evidence record binding the action to its mandate, model version, policy verdict, oversight state, and financial blast radius.

The same event that governs the action becomes the proof of how it was governed. One pipeline, two outputs: an agent action can never be governed without being recorded, or recorded without its governing context.

## Why Pharos

No existing category closes this loop:

- **Security platforms** (Cisco AI Defense, Palo Alto Prisma AIRS) block threats but produce no admissible evidence.
- **Governance platforms** (Credo AI, OneTrust) document policy but never touch runtime.
- **Insurers** (AIUC, Armilla, Testudo) price risk but have no telemetry.

Pharos is the single product that lets a compliance officer authorize agents, an examiner audit them, a general counsel defend them, and an underwriter price them.

> **Positioning:** Pharos is the policy decision point and evidence ledger for AI agents — deterministic, citation-backed verdicts in under 800 milliseconds, and litigation-grade proof of every decision, forever.

## The two surfaces

| | Pharos Beam — Decide | Pharos Ledger — Prove |
|---|---|---|
| Role | Runtime decision plane | Evidence & liability plane |
| Delivers | Policy packs, compiler, dry-run, tiered verdict cascade, review operations | Evidence explorer, risk profile, readiness gate, claims packs, exchange portal |

One login, one RBAC model, one tenant boundary.

The name carries the architecture: the Pharos of Alexandria both guided ships in real time and stood for centuries as proof of where the harbor was.

## How it works

Every consequential agent action flows through a single ingestion surface — one SDK call, or a no-code MCP/gateway proxy. The verdict cascade evaluates it across tiers (deterministic rules, statistical risk scoring, then a served distilled judge model) within an 800ms envelope, with deterministic short-circuiting and engineered fail-open / fail-closed paths.

The verdict response and the sealed evidence record are two outputs of the same transaction. The universal `ActionRecord` event carries both the verdict context (tier reached, rule citations, risk score, fail-mode) and the liability context (mandate ID and scope, oversight mode, blast radius, reversibility, model metadata) — signed once, chained once.

### Architecture at a glance

- **Operational state** — Postgres (policies, mandates, queues, tenants)
- **Evidence chain** — WORM object storage (S3 Object Lock), hash-chained and continuously verified
- **Verdict caches** — Redis, deadline-bound
- **Signing** — KMS/HSM-backed keys with rotation and chain continuity
- **Deployment** — SaaS (multi-tenant), dedicated VPC, and customer-hosted (Helm/Compose)

See [docs/architecture.md](docs/architecture.md) for the implemented design.

## Status

Built sprint-by-sprint against [the roadmap](docs/ROADMAP.md). Sequence and proof are the contract: no external claim ships before its proof exists, and every milestone is a live demo with measured exit criteria — not a document.

**Sprint 0 (Bedrock) — complete.** A single deployable platform where an agent action receives a verdict and produces a sealed, durable, externally-verifiable evidence record — surviving restarts, verifiable genesis-to-head.

**Sprint 1 (Gatehouse) — complete.** Enterprise SSO (OIDC, verified against Okta + Entra), scoped + rotatable API keys, deny-by-default RBAC, hard multi-tenant isolation (Postgres RLS under a `NOBYPASSRLS` app role + per-tenant signing keys), a hash-chained access audit, and CORS/rate-limit hardening. The tenant-isolation attack suite (cross-tenant reads, IDOR, scope escalation, revoked-key reuse, DB-level RLS) finds zero crossings. See [docs/identity-and-tenancy.md](docs/identity-and-tenancy.md).

**Sprint 2 (Lantern) — complete.** A real tiered decision cascade (Tier 1 deterministic rules → Tier 2 statistical risk → Tier 3 served distilled judge models with a versioned registry), a hard 800ms deadline manager with engineered fail-open/fail-closed semantics, and a reproducibility (replay) harness. Measured: **p99 3.7ms at ~5,400 verdicts/sec** (budget 800ms; [benchmark](docs/benchmarks/latency.md)). Semantic evaluation is learned models, **zero regex**. See [docs/decision-cascade.md](docs/decision-cascade.md).

**Sprint 3 (Causeway) — complete.** Production SDKs (TypeScript + Python — deadline-aware, retries, local fail-mode), framework middlewares for LangChain/LangGraph, OpenAI Agents, Anthropic SDK, CrewAI, and the MS Agent Framework (all passing one conformance contract), a zero-code HTTP egress **gateway**, programmatic **mandates** (a $25k mandate blocks a $30k action at Tier 1), and **workflow continuation** — an escalated action parks, a human verdict seals a tier-`human` record, and the agent resumes **exactly once**. An unmodified agent is governed purely via the gateway. See [docs/sdks-and-integration.md](docs/sdks-and-integration.md).

**Sprint 4 (Watchroom) — complete.** Review operations as an OS: a queue engine routing escalations by action class / risk / regulation pack (treasury-control, privacy-office, registered-principal), a deadline-aware SLA engine with exactly-once breach alerts, multi-channel notifications with an audited delivery log, reviewer analytics (review time, SLA attainment, throughput, measured disagreement rate), and a disagreement→draft-rule feedback loop. A seeded **500-escalation backlog drains within SLA across three reviewer roles** (100% attainment) with every breach alert firing. See [docs/review-operations.md](docs/review-operations.md).

**Sprint 5 (Seal) — complete.** Legally-usable evidence: independent trusted-time anchoring, **field-level redaction via selective disclosure** (a redacted pack verifies cryptographically; the unredacted original stays intact), litigation hold (which disables redaction on held records), audience-scoped **claims packs** (draft→sealed→released) that a third party **verifies offline using only the bundle**, the FINRA / EU AI Act Art. 12 / SR 11-7 regulatory exports, and a consent-gated, access-audited exchange portal. The full incident drill — declare → hold → assemble → seal → release → offline-verify — passes end to end. See [docs/evidence-seal.md](docs/evidence-seal.md) and the [admissibility white paper](docs/legal/admissibility.md).

**Sprint 6 (Codex) — complete.** Citation-level **FINRA pack v2** (2210/3110/2150) and **HIPAA pack v2** (minimum-necessary, PHI-in-context, authorization-state, breach triggers) as versioned artifacts — every rule names its clause and renders an examiner-readable explanation. A natural-language **policy compiler** and a full **policy lifecycle**: compile → dry-run (impact dashboard) → shadow (with divergence) → active → **rollback in under a minute** (chain undisturbed). A compiled policy's dry-run prediction matches observed verdicts after activation. See [docs/regulation-packs-and-policy.md](docs/regulation-packs-and-policy.md).

**Sprint 7 (Beam Count) — complete.** Operationalized trust mathematics: a continuous assurance engine sampling verdicts into human audits and reporting a **measured Wilson-score verified-accuracy lower bound** (no modeled placeholder), a unified **risk profile v2** (autonomy rate, irreversible mix, policy-failure rate, blast radius, oversight coverage + escalation/disagreement/assurance signals → composite grade), a **readiness gate** that blocks external release on a failing check with an owner-exception workflow, and a versioned, consent-gated **underwriter feed**. Verified accuracy computes from 1,000+ real audits; the readiness gate blocks the feed on a mandate-coverage failure until an exception is granted. See [docs/assurance-and-risk.md](docs/assurance-and-risk.md).

141 TS tests + 10 Python tests green (adds assurance + Beam Count integration against real Postgres / S3 WORM / Redis).

## Monorepo layout

```
packages/core      domain: ActionRecord schema v1, hashing, sealing, chain verify, KMS signing, verdict engine, migration
packages/config    fail-fast environment configuration
packages/storage   Postgres + S3 WORM + Redis; transactional write path; chain-integrity service
services/api       Fastify ingestion API + composition root
apps/console       Next.js console (Beam / Ledger IA)
scripts            durability demo + standalone external verifier
docs               architecture, frozen schema, external-verification walkthrough, audits, roadmap
```

## Quickstart

```bash
pnpm install
pnpm infra:up                     # Postgres + Redis + MinIO (S3 WORM) via docker compose
cp .env.example .env

pnpm test                         # unit tests (+ durability integration test if infra is up)

pnpm demo:durability              # submit demo actions, seal records
pnpm demo:durability --verify     # cold restart: records persist, chain verifies genesis→head

pnpm api:dev                      # serve the ingestion API on :4000
pnpm verify:external demo-tenant  # third-party offline, zero-trust verification

pnpm --filter @pharos/console dev # the console on :3000
```

## The unified event

One `ActionRecord` carries the Beam verdict context and the Ledger liability context, signed once and chained once. See [docs/schema-v1.md](docs/schema-v1.md).

```
POST /v1/actions  →  { verdict, record }     # two outputs of one transaction
```

## Verification

The evidence chain is verifiable by any third party with only the exported records and the published public keyset — no Pharos infrastructure required. See [docs/external-verification.md](docs/external-verification.md).

---

*Pharos decides. Pharos proves.*
