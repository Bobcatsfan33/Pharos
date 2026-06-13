# SOC 2, vendor security & data processing (Sprint 8 — Granite)

Procurement is a feature. Every enterprise deal stalls without these. The controls below are
implemented in-product; the attestations are external/human gates tracked here.

## SOC 2 readiness — control mapping

| Trust Services Criterion | Pharos control | Where |
|--------------------------|----------------|-------|
| CC6.1 Logical access | OIDC/SAML SSO + scoped API keys + deny-by-default RBAC | [identity-and-tenancy](../identity-and-tenancy.md) |
| CC6.1 Tenant isolation | Postgres RLS under a NOBYPASSRLS app role + per-tenant keys | [identity-and-tenancy](../identity-and-tenancy.md) |
| CC7.2 Monitoring | Prometheus metrics, OTel traces, alerting runbooks | [operations](../operations.md) |
| CC7.3 Incident response | Litigation hold + claims packs + access audit | [evidence-seal](../evidence-seal.md) |
| A1.2 Availability | Multi-AZ, RPO/RTO, tested region failover | [operations](../operations.md) |
| PI1.x Processing integrity | Hash-chained, signed evidence; reproducible verdicts | [architecture](../architecture.md), [decision-cascade](../decision-cascade.md) |
| C1.x Confidentiality | Field-level redaction (selective disclosure); CORS/TLS | [evidence-seal](../evidence-seal.md) |

> **Attestation status (external gates).** SOC 2 Type I report issuance and the Type II
> observation window are auditor engagements; this document is the control inventory the
> auditor maps against. The supply-chain CI (CodeQL/Trivy/SBOM in `ci.yml` and the broader
> roadmap) supports the evidence.

## Vendor security questionnaire (SIG / CAIQ) — answer pack

- **Data at rest:** Postgres (encrypted volumes), S3 with Object Lock; KMS-managed keys.
- **Data in transit:** TLS to all components; mTLS optional between control-plane and agents.
- **Access control:** SSO + SCIM + scoped keys; deny-by-default RBAC; access fully audited.
- **Tenant isolation:** application-layer authorization + database RLS (defense in depth).
- **Audit logging:** hash-chained access audit; immutable evidence chain.
- **Subprocessors:** customer-hosted mode has none at runtime (airgap-tolerant).
- **Vulnerability management:** CI security scans; dependency review; minimal runtime deps.
- **BC/DR:** documented RPO/RTO; tested region failover with zero evidence loss.

## Data processing addendum (DPA)

- **Roles:** customer is controller; Pharos is processor (SaaS) or not a processor at all
  (customer-hosted — data never leaves the customer environment).
- **Purpose limitation:** data is processed only to render verdicts and seal evidence.
- **Retention:** evidence retention is configurable per tenant and survives tenant deletion
  where legally required (litigation hold).
- **Sub-processing & transfers:** none at runtime in customer-hosted mode.
- **AI-Act awareness:** Article 12 record-keeping export is provided; logs are
  traceability-grade by construction.

These are template positions for counsel to finalize with the customer.
