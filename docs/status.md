# Status — sprint history

> Moved out of the README so the front page stays readable for a first-time visitor. This
> is the detailed build log; the honest short version, plus the machine-checked readiness
> manifest, lives in the README's **Status** section.
>
> Nothing here is a production-approval claim. `docs/enterprise-readiness.json` remains
> `decision: not-approved`, and [`docs/LIMITATIONS.md`](LIMITATIONS.md) enumerates every
> known gap.

## The two surfaces

| | Pharos Beam — Decide | Pharos Ledger — Prove |
|---|---|---|
| Role | Runtime decision plane | Evidence & liability plane |
| Delivers | Policy packs, compiler, dry-run, tiered verdict cascade, review operations | Evidence explorer, risk profile, readiness gate, claims packs, exchange portal |

One login, one RBAC model, one tenant boundary. The name carries the architecture: the
Pharos of Alexandria both guided ships in real time and stood for centuries as proof of
where the harbor was.

## Sprints

**Sprint 0 (Bedrock) — complete.** A single deployable platform where an agent action receives a verdict and produces a sealed, durable, externally-verifiable evidence record — surviving restarts, verifiable genesis-to-head.

**Sprint 1 (Gatehouse) — complete.** Enterprise SSO (OIDC, verified against Okta + Entra), scoped + rotatable API keys, deny-by-default RBAC, hard multi-tenant isolation (Postgres RLS under a `NOBYPASSRLS` app role + per-tenant signing keys), a hash-chained access audit, and CORS/rate-limit hardening. The tenant-isolation attack suite (cross-tenant reads, IDOR, scope escalation, revoked-key reuse, DB-level RLS) finds zero crossings. See [docs/identity-and-tenancy.md](docs/identity-and-tenancy.md).

**Sprint 2 (Lantern) — complete.** A real tiered decision cascade (Tier 1 deterministic rules → Tier 2 statistical risk → Tier 3 served judge models with a versioned registry), a hard 800ms deadline manager with engineered fail-open/fail-closed semantics, and a reproducibility (replay) harness. The registry now dispatches either the measured linear development baseline or CPU ONNX transformers through the same contract; production startup requires and verifies all three transformer artifacts and never silently falls back. Independent concern models execute concurrently, and monotonic post-inference enforcement prevents a CPU-starved timer from releasing an expired normal verdict. The **[Tier-3 judge eval baseline](benchmarks/judge-evals.md)** and **[encoding system evaluation](benchmarks/system-encoding-eval.md)** remain honest about the evidence boundary. The ONNX-default benchmark is now production-faithful and shows that the 800ms low-concurrency envelope can hold on the reference host while the 1,000 verdicts/sec production-topology gate remains open. See [decision-cascade.md](decision-cascade.md).

**Sprint 3 (Causeway) — complete.** Production SDKs (TypeScript + Python — deadline-aware, retries, local fail-mode), framework middlewares for LangChain/LangGraph, OpenAI Agents, Anthropic SDK, CrewAI, and the MS Agent Framework (all passing one conformance contract), a zero-code HTTP egress **gateway**, programmatic **mandates** (a $25k mandate blocks a $30k action at Tier 1), and **workflow continuation** — an escalated action parks, a human verdict seals a tier-`human` record, and an atomic claim permits one resumer. Gateway continuations are encrypted in Postgres and survive process restart; a stable idempotency key lets a compliant upstream deduplicate an ambiguous delivery retry, and production startup now actively proves that contract against a connector-owned conformance endpoint. An unmodified agent is governed purely via the gateway. See [docs/sdks-and-integration.md](docs/sdks-and-integration.md).

**Sprint 4 (Watchroom) — complete.** Review operations as an OS: a queue engine routing escalations by action class / risk / regulation pack (treasury-control, privacy-office, registered-principal), a deadline-aware SLA engine with exactly-once breach alerts, multi-channel notifications with an audited delivery log, reviewer analytics (review time, SLA attainment, throughput, measured disagreement rate), and a disagreement→draft-rule feedback loop. A seeded **500-escalation backlog drains within SLA across three reviewer roles** (100% attainment) with every breach alert firing. See [docs/review-operations.md](docs/review-operations.md).

**Sprint 5 (Seal) — complete.** Legally-usable evidence: RFC 3161 trusted-time anchoring bound to independently approved TSA certificate pins in production, **field-level redaction via selective disclosure** (a redacted pack verifies cryptographically; the unredacted original stays intact), litigation hold (which disables redaction on held records), audience-scoped **claims packs** (draft→sealed→released) that a third party verifies offline using the bundle plus independently approved TSA trust material, the FINRA / EU AI Act Art. 12 / SR 11-7 regulatory exports, and a consent-gated, access-audited exchange portal. The full incident drill — declare → hold → assemble → seal → release → offline-verify — passes end to end. See [docs/evidence-seal.md](docs/evidence-seal.md) and the [admissibility white paper](docs/legal/admissibility.md).

**Sprint 6 (Codex) — complete.** Citation-level **FINRA pack v2** (2210/3110/2150) and **HIPAA pack v2** (minimum-necessary, PHI-in-context, authorization-state, breach triggers) as versioned artifacts — every rule names its clause and renders an examiner-readable explanation. A **constrained-grammar policy compiler (v1)** — a line-oriented grammar that maps a handful of plain-English policy patterns to candidate rules for human approval (not a general natural-language compiler; see [docs/LIMITATIONS.md](docs/LIMITATIONS.md)) — and a full **policy lifecycle**: compile → dry-run (impact dashboard) → shadow (with divergence) → active → **rollback in under a minute** (chain undisturbed). A compiled policy's dry-run prediction matches observed verdicts after activation. See [docs/regulation-packs-and-policy.md](docs/regulation-packs-and-policy.md).

**Sprint 7 (Beam Count) — complete.** Operationalized trust mathematics: a continuous assurance engine sampling verdicts into human audits and reporting a **measured Wilson-score verified-accuracy lower bound** (no modeled placeholder), a unified **risk profile v2** (autonomy rate, irreversible mix, policy-failure rate, blast radius, oversight coverage + escalation/disagreement/assurance signals → composite grade), a **readiness gate** that blocks external release on a failing check with an owner-exception workflow, and a versioned, consent-gated **underwriter feed**. Verified accuracy computes from 1,000+ real audits; the readiness gate blocks the feed on a mandate-coverage failure until an exception is granted. See [docs/assurance-and-risk.md](docs/assurance-and-risk.md).

**Sprint 8 (Granite) — complete.** Buyable by a bank: **observability** (Prometheus `/metrics`, OTel-style tracing, alerting runbooks), **resilience** (multi-AZ, documented RPO/RTO, a region-failover exercise with **zero evidence loss** and the chain re-verifying green on the recovered region), **customer-hosted GA** (hardened Compose + Helm chart + install-from-docs, CPU-only judge), and **metering/billing** for the three-part model with invoices that **reconcile to recorded usage exactly**. SOC 2 control mapping, SIG/CAIQ answer pack, and DPA templates prepared. See [docs/operations.md](docs/operations.md), [deploy/INSTALL.md](deploy/INSTALL.md), and [docs/compliance/soc2-and-procurement.md](docs/compliance/soc2-and-procurement.md).

**Sprint 9 (Signal) — complete.** GA, standards, and the channel: the **open PDP specification v1.0** is public with a conformance suite and an **independent reference implementation that conforms** (alongside the Pharos cascade), a public `POST /v1/pdp` endpoint returning a signed **evidence binding**, AIUC-1 accountability-pillar + NAIC mappings, identity-rail integration (Okta for AI Agents / Entra Agent ID via OIDC), published GA pricing, and the insurer channel. See [docs/spec/pdp-v1.md](docs/spec/pdp-v1.md) and [docs/standards-and-channel.md](docs/standards-and-channel.md).

157 TS tests + 10 Python tests green (adds PDP conformance + Signal integration against real Postgres / S3 WORM / Redis).

---

**All ten prototype sprints (Bedrock → Signal) are code-complete and milestone-verified** against [docs/ROADMAP.md](docs/ROADMAP.md) — every exit criterion is exercised by passing tests against real infrastructure. Two kinds of work remain:

- **Production-hardening engineering.** Several sprint deliverables still need promotion work, led by independently validating, calibrating, documenting, and production-benchmarking the transformer judges and onboarding approved KMS/TSA trust. The gateway's held-request state is now size-capped, tenant-isolated, encrypted in Postgres, and restart-tested. Every remaining limitation is enumerated in **[docs/LIMITATIONS.md](docs/LIMITATIONS.md)**.
- **External/human gates.** Outside-counsel and consultant reviews, SOC 2 attestation, a commissioned penetration test, design-partner/pilot/production-customer signatures, carrier feed confirmations, and publishing the SDKs to PyPI/npm — none of which are code.
