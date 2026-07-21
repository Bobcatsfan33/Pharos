# Pharos — Product & Engineering Roadmap

> This is the governing document. Sequence and proof are the contract; velocity is a
> staffing decision. Sprints are built end-to-end (an agent action → a verifiable
> artifact), milestones are demos not documents, claims follow code, and GTM is
> milestone-gated. Build sprint to sprint until complete.

## 1. Vision and thesis

Pharos is the trust control plane for enterprise AI agents. Every consequential agent
action passes through Pharos twice: once before it happens — a real-time policy verdict
(allow, block, modify, escalate) issued through a tiered decision cascade under a hard
latency budget — and once after — a tamper-evident, cryptographically signed evidence
record binding the action to its mandate, model version, policy verdict, oversight state,
and financial blast radius. The same event that governs the action becomes the proof of
how it was governed.

No competitor closes this loop: security platforms block threats but produce no
admissible evidence; governance platforms document policy but never touch runtime;
insurers price risk but have no telemetry. Pharos is the single product that lets a
compliance officer authorize agents, an examiner audit them, a general counsel defend
them, and an underwriter price them.

Two surfaces inherit the lighthouse metaphor — **Pharos Beam** (the runtime decision
plane) and **Pharos Ledger** (the evidence and liability plane).

**Positioning.** Pharos is the policy decision point and evidence ledger for AI agents —
deterministic, citation-backed verdicts in under 800 milliseconds, and litigation-grade
proof of every decision, forever.

## 2. Unification target architecture

One platform, one domain model, one event pipeline with two consumers.

- **Single pipeline** — one ingestion surface (SDK call + no-code MCP/gateway proxy); the
  verdict response and the sealed evidence record are two outputs of the same transaction.
- **Unified domain model** — `ActionRecord` is the universal event carrying verdict fields
  (tier, citations, risk, fail-mode) and liability fields (mandate, oversight, blast
  radius, reversibility, model metadata), signed once, chained once.
- **Storage tiers** — Postgres (operational), S3 Object-Lock WORM (evidence chain), Redis
  (verdict cache), per-tenant signing keys with rotation via a KMS abstraction (local KMS
  today; AWS KMS/HSM is roadmap task S3-T1).
- **Two surfaces** — Beam (policy packs, compiler, dry-run, cascade, review ops); Ledger
  (evidence explorer, risk profile, readiness gate, claims packs, exchange portal). One
  login, one RBAC model, one tenant boundary.
- **Deployment** — SaaS, dedicated VPC, customer-hosted (Helm/Compose). No sprint may
  foreclose customer-hosted.

## 3. How this roadmap works

- **End-to-end or nothing** — every sprint is an integration slice ending in a verifiable
  artifact.
- **Milestones are demos** — done = exit criteria pass in a deployed environment.
- **Claims follow code** — no external claim ships before its proof exists.
- **GTM is milestone-gated** — design partners at M3, paid pilots at M6, GA + insurer
  channel at M9.
- **Sequence is the strategy** — each sprint de-risks the next.

## 4. Sprint plan (summary)

| Sprint | Name | Objective | Key exit criteria |
|--------|------|-----------|-------------------|
| 0 | **Bedrock** | One platform, durable by default | Verdict + sealed record survive restart; chain verifies genesis→head; zero in-memory stores; keys in KMS; schema v1 frozen; legacy datasets migrate |
| 1 | **Gatehouse** | Identity, tenancy, access audit | Two-tenant isolation suite zero crossings + pen test clean; chained access audit; SSO vs Okta+Entra; key rotation mid-stream no dropped records |
| 2 | **Lantern** | Real decision engine + measured latency | p99 < 800ms @ 1k verdicts/s for 1h (measured with the current linear judges; re-benchmarked with transformer judges in Phase 2 / S7-T1); real Tier-3 served judge — today linear bag-of-words classifiers, model-scored not pattern-matched, transformers in Phase 2; chaos-proven fail modes; 10 verdicts replay bit-identical |
| 3 | **Causeway** | SDKs, gateway, escalation round trip | Reference + unmodified agent both block→escalate→human verdict→resume exactly-once; middlewares pass conformance; $25k mandate blocks $30k; 3 design partners |
| 4 | **Watchroom** | Review operations OS | 500-escalation drill within SLA; reviewer verdicts sealed as evidence; disagreement dashboard live + 1 policy improvement shipped |
| 5 | **Seal** | Legally-usable evidence + exchange portal | Incident drill offline-verified by third party; counsel-reviewed admissibility white paper; 3 regulatory exports; redacted packs verify |
| 6 | **Codex** | Regulation packs + policy lifecycle | Policy doc compile→dry-run 90d→shadow→active w/ impact match; FINRA+HIPAA packs pass consultant review; rollback <1min; 2 paid pilots |
| 7 | **Beam Count** | Assurance, risk profile, underwriter feed | Wilson-score accuracy from ≥1000 real audits, placeholder deleted; 2 carriers consume feed in writing; readiness gate blocks on mandate-coverage failure |
| 8 | **Granite** | Enterprise hardening, certification, billing | Region failover zero evidence loss; customer-hosted install from docs alone; SOC2 Type I issued; first invoices reconcile exactly |
| 9 | **Signal** | GA, open PDP spec, channel | PDP spec v1.0 public w/ ≥1 non-Pharos impl; ≥1 carrier references Pharos telemetry; 3 paying production customers; GA with both proof assets public |

Full per-sprint engineering/product/verification detail is preserved in the original
roadmap brief that seeded this repository; the table above is the working checklist.

## 5. Success metrics (bar at GA)

- p99 end-to-end verdict latency < 800ms at 1,000 verdicts/sec/region.
- Wilson-score lower-bound verified accuracy ≥ 90% at 95% confidence, per pack (measured).
- 100% chain verification across all tenants; zero evidence-loss incidents.
- ≥ 95% escalation SLA attainment; ≥ 60% review-volume reduction vs all-human baseline.
- 5 design partners → ≥ 3 paying production customers; ≥ 2 carriers consuming the feed.
- 100% metered-usage reconciliation; 100% of external claims backed by published proof.

## 6. Risk register (kill criteria highlights)

- **Two-codebase merge drags** — if unification exceeds two sprint cycles, freeze the
  Flightline UI, ship Lighthouse-first on the unified schema, port views opportunistically.
- **Latency claim fails under load** — short-circuiting + caching first; if structural,
  re-scope the deadline by action class before any external claim ships.
- **Judge quality insufficient in a domain** — a pack whose measured assurance misses the
  bar does not ship, regardless of roadmap pressure.

## 7. Explicitly deferred (post-M9)

Additional vertical packs beyond FINRA/HIPAA; EU AI Act Annex III examiner workflows;
agent marketplaces / self-serve onboarding; hardware attestation; mobile consoles.
