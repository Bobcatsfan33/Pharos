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

The verdict response and the sealed evidence record are two outputs of the same transaction. The universal ActionRecord event carries both the verdict context (tier reached, rule citations, risk score, fail-mode) and the liability context (mandate ID and scope, oversight mode, blast radius, reversibility, model metadata) — signed once, chained once.

### Architecture at a glance

- **Operational state** — Postgres (policies, mandates, queues, tenants)
- **Evidence chain** — WORM object storage (S3 Object Lock), hash-chained and continuously verified
- **Verdict caches** — Redis, deadline-bound
- **Signing** — KMS/HSM-backed per-tenant keys with rotation and chain continuity
- **Deployment** — SaaS (multi-tenant), dedicated VPC, and customer-hosted (Helm/Compose)

## Who it's for

- **Primary buyers:** Chief Compliance Officer, General Counsel (financial services first, healthcare second)
- **Economic influencers:** Chief Risk Officer, CISO
- **Channel:** insurance brokers and AI-liability underwriters who consume Pharos risk profiles and specify Pharos into policies
- **Implementers:** platform engineering

## Capabilities

- **Real-time verdicts** — tiered cascade with rule-citation explanations written for an examiner, not a developer
- **Mandates** — scope, limits, grantor, expiry; evaluated as a first-class verdict input and sealed into every record
- **Workflow continuation** — escalated actions park with full context and resume, rewrite, or cancel the agent's pending step after a human verdict, with exactly-once guarantees
- **Review operations** — routed queues with SLAs, reviewer workspace, analytics, and a human-feedback loop that turns disagreements into draft policy rules
- **Admissible evidence** — RFC 3161 trusted timestamps, external anchoring, field-level redaction, litigation hold, and offline-verifiable claims packs
- **Regulation packs** — citation-level FINRA and HIPAA content, plus a policy compiler and full draft → shadow → dry-run → active → rollback lifecycle
- **Regulatory exports** — FINRA examination, EU AI Act Article 12, and SR 11-7 model-risk formats
- **Risk profile & underwriter feed** — continuous, sampling-based assurance with Wilson-score confidence bounds, exported to carriers as a consent-gated risk signal

## Integrations

Production Python and TypeScript SDKs, first-class middlewares for LangChain/LangGraph, CrewAI, the OpenAI Agents SDK, the Anthropic SDK, and the Microsoft Agent Framework, plus an MCP/HTTP-egress gateway proxy that governs agents with zero code changes.

## Status

Pharos is under active development on a milestone-gated roadmap. Sequence and proof are the contract: no external claim ships before its proof exists, and every milestone is a live demo with measured exit criteria — not a document.

---

*Pharos decides. Pharos proves.*
