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

Every consequential agent action flows through a single ingestion surface — one SDK call, or a no-code MCP/gateway proxy. The verdict cascade evaluates it across tiers (deterministic rules, statistical risk scoring, then a served judge model — today a linear bag-of-words classifier standing in for a transformer judge; see [docs/LIMITATIONS.md](docs/LIMITATIONS.md)) within an 800ms envelope, with deterministic short-circuiting and engineered fail-open / fail-closed paths.

The verdict response and the sealed evidence record are two outputs of the same transaction. The universal `ActionRecord` event carries both the verdict context (tier reached, rule citations, risk score, fail-mode) and the liability context (mandate ID and scope, oversight mode, blast radius, reversibility, model metadata) — signed once, chained once.

### Architecture at a glance

- **Operational state** — Postgres (policies, mandates, queues, tenants)
- **Evidence chain** — WORM object storage (S3 Object Lock), hash-chained and continuously verified
- **Verdict caches** — Redis, deadline-bound
- **Signing** — a pluggable `SigningProvider`; today a local KMS (Ed25519 keys in an on-disk keystore) with rotation and chain continuity. AWS KMS/HSM-backed signing is roadmap task S3-T1 (a config enum today, not yet functional).
- **Deployment** — SaaS (multi-tenant), dedicated VPC, and customer-hosted (Helm/Compose)

See [docs/architecture.md](docs/architecture.md) for the implemented design.

## Status

Built sprint-by-sprint against [the roadmap](docs/ROADMAP.md). Sequence and proof are the contract: no external claim ships before its proof exists, and every milestone is a live demo with measured exit criteria — not a document.

> **Known gaps and stand-ins.** Several components are implemented today as honest placeholders for their production versions (linear judges, local KMS, a simulated TSA, the gateway's in-memory held-request state). Every one is listed, with the roadmap task that replaces it, in **[docs/LIMITATIONS.md](docs/LIMITATIONS.md)**. Read it before evaluating Pharos against a production bar.

**Sprint 0 (Bedrock) — complete.** A single deployable platform where an agent action receives a verdict and produces a sealed, durable, externally-verifiable evidence record — surviving restarts, verifiable genesis-to-head.

**Sprint 1 (Gatehouse) — complete.** Enterprise SSO (OIDC, verified against Okta + Entra), scoped + rotatable API keys, deny-by-default RBAC, hard multi-tenant isolation (Postgres RLS under a `NOBYPASSRLS` app role + per-tenant signing keys), a hash-chained access audit, and CORS/rate-limit hardening. The tenant-isolation attack suite (cross-tenant reads, IDOR, scope escalation, revoked-key reuse, DB-level RLS) finds zero crossings. See [docs/identity-and-tenancy.md](docs/identity-and-tenancy.md).

**Sprint 2 (Lantern) — complete.** A real tiered decision cascade (Tier 1 deterministic rules → Tier 2 statistical risk → Tier 3 served judge models with a versioned registry), a hard 800ms deadline manager with engineered fail-open/fail-closed semantics, and a reproducibility (replay) harness. Today the Tier-3 judges are **linear bag-of-words logistic-regression classifiers** standing in for transformer judges — the cascade interface is identical, so the model type can be upgraded without touching it (transformer judges are roadmap Phase 2; see [docs/LIMITATIONS.md](docs/LIMITATIONS.md)). Measured **with the current linear judges: p99 3.7ms at ~5,400 verdicts/sec** (budget 800ms; [benchmark](docs/benchmarks/latency.md)) — to be re-benchmarked when transformer judges land (roadmap task S7-T1). Semantic evaluation is decided by learned model weights, not hand-written patterns. See [docs/decision-cascade.md](docs/decision-cascade.md).

**Sprint 3 (Causeway) — complete.** Production SDKs (TypeScript + Python — deadline-aware, retries, local fail-mode), framework middlewares for LangChain/LangGraph, OpenAI Agents, Anthropic SDK, CrewAI, and the MS Agent Framework (all passing one conformance contract), a zero-code HTTP egress **gateway**, programmatic **mandates** (a $25k mandate blocks a $30k action at Tier 1), and **workflow continuation** — an escalated action parks, a human verdict seals a tier-`human` record, and the agent resumes **exactly once**. An unmodified agent is governed purely via the gateway. See [docs/sdks-and-integration.md](docs/sdks-and-integration.md).

**Sprint 4 (Watchroom) — complete.** Review operations as an OS: a queue engine routing escalations by action class / risk / regulation pack (treasury-control, privacy-office, registered-principal), a deadline-aware SLA engine with exactly-once breach alerts, multi-channel notifications with an audited delivery log, reviewer analytics (review time, SLA attainment, throughput, measured disagreement rate), and a disagreement→draft-rule feedback loop. A seeded **500-escalation backlog drains within SLA across three reviewer roles** (100% attainment) with every breach alert firing. See [docs/review-operations.md](docs/review-operations.md).

**Sprint 5 (Seal) — complete.** Legally-usable evidence: trusted-time anchoring (today a **simulated TSA** — an independent signing key standing in for an RFC 3161 timestamp authority; the real RFC 3161 client is roadmap task S4-T1, see [docs/LIMITATIONS.md](docs/LIMITATIONS.md)), **field-level redaction via selective disclosure** (a redacted pack verifies cryptographically; the unredacted original stays intact), litigation hold (which disables redaction on held records), audience-scoped **claims packs** (draft→sealed→released) that a third party **verifies offline using only the bundle**, the FINRA / EU AI Act Art. 12 / SR 11-7 regulatory exports, and a consent-gated, access-audited exchange portal. The full incident drill — declare → hold → assemble → seal → release → offline-verify — passes end to end. See [docs/evidence-seal.md](docs/evidence-seal.md) and the [admissibility white paper](docs/legal/admissibility.md).

**Sprint 6 (Codex) — complete.** Citation-level **FINRA pack v2** (2210/3110/2150) and **HIPAA pack v2** (minimum-necessary, PHI-in-context, authorization-state, breach triggers) as versioned artifacts — every rule names its clause and renders an examiner-readable explanation. A **constrained-grammar policy compiler (v1)** — a line-oriented grammar that maps a handful of plain-English policy patterns to candidate rules for human approval (not a general natural-language compiler; see [docs/LIMITATIONS.md](docs/LIMITATIONS.md)) — and a full **policy lifecycle**: compile → dry-run (impact dashboard) → shadow (with divergence) → active → **rollback in under a minute** (chain undisturbed). A compiled policy's dry-run prediction matches observed verdicts after activation. See [docs/regulation-packs-and-policy.md](docs/regulation-packs-and-policy.md).

**Sprint 7 (Beam Count) — complete.** Operationalized trust mathematics: a continuous assurance engine sampling verdicts into human audits and reporting a **measured Wilson-score verified-accuracy lower bound** (no modeled placeholder), a unified **risk profile v2** (autonomy rate, irreversible mix, policy-failure rate, blast radius, oversight coverage + escalation/disagreement/assurance signals → composite grade), a **readiness gate** that blocks external release on a failing check with an owner-exception workflow, and a versioned, consent-gated **underwriter feed**. Verified accuracy computes from 1,000+ real audits; the readiness gate blocks the feed on a mandate-coverage failure until an exception is granted. See [docs/assurance-and-risk.md](docs/assurance-and-risk.md).

**Sprint 8 (Granite) — complete.** Buyable by a bank: **observability** (Prometheus `/metrics`, OTel-style tracing, alerting runbooks), **resilience** (multi-AZ, documented RPO/RTO, a region-failover exercise with **zero evidence loss** and the chain re-verifying green on the recovered region), **customer-hosted GA** (hardened Compose + Helm chart + install-from-docs, CPU-only judge), and **metering/billing** for the three-part model with invoices that **reconcile to recorded usage exactly**. SOC 2 control mapping, SIG/CAIQ answer pack, and DPA templates prepared. See [docs/operations.md](docs/operations.md), [deploy/INSTALL.md](deploy/INSTALL.md), and [docs/compliance/soc2-and-procurement.md](docs/compliance/soc2-and-procurement.md).

**Sprint 9 (Signal) — complete.** GA, standards, and the channel: the **open PDP specification v1.0** is public with a conformance suite and an **independent reference implementation that conforms** (alongside the Pharos cascade), a public `POST /v1/pdp` endpoint returning a signed **evidence binding**, AIUC-1 accountability-pillar + NAIC mappings, identity-rail integration (Okta for AI Agents / Entra Agent ID via OIDC), published GA pricing, and the insurer channel. See [docs/spec/pdp-v1.md](docs/spec/pdp-v1.md) and [docs/standards-and-channel.md](docs/standards-and-channel.md).

157 TS tests + 10 Python tests green (adds PDP conformance + Signal integration against real Postgres / S3 WORM / Redis).

---

**All ten sprints (Bedrock → Signal) are code-complete and milestone-verified.** Every milestone's exit criteria are exercised by passing tests against real infrastructure. The remaining items are explicitly external/human gates — outside-counsel and consultant reviews, SOC 2 attestation, a commissioned penetration test, design-partner/pilot/production-customer signatures, carrier feed confirmations, and publishing the SDKs to PyPI/npm — none of which are code. See [docs/ROADMAP.md](docs/ROADMAP.md).

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

pnpm test                         # 157 tests against real Postgres/Redis/MinIO (needs infra:up)

pnpm demo:durability              # submit demo actions, seal records
pnpm demo:durability --verify     # cold restart: records persist, chain verifies genesis→head
```

The API and the offline verifier run in **two terminals** — `verify:external` fetches the
exported bundle from the running API:

```bash
# terminal 1 — leave this running
pnpm api:dev                      # serve the ingestion API on :4000

# terminal 2
pnpm verify:external demo-tenant  # third-party offline, zero-trust verification (needs api:dev)

pnpm --filter @pharos/console dev # (optional) the Next.js console on :3000
```

For a step-by-step, clean-machine walkthrough with expected output, see
[docs/ONBOARDING.md](docs/ONBOARDING.md).

## The unified event

One `ActionRecord` carries the Beam verdict context and the Ledger liability context, signed once and chained once. See [docs/schema-v1.md](docs/schema-v1.md).

```
POST /v1/actions  →  { verdict, record }     # two outputs of one transaction
```

## Verification

The evidence chain is verifiable by any third party with only the exported records and the published public keyset — no Pharos infrastructure required. See [docs/external-verification.md](docs/external-verification.md).

---

*Pharos decides. Pharos proves.*
