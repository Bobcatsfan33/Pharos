# Enterprise procurement and deployment decision

[`enterprise-readiness.json`](enterprise-readiness.json) is the authoritative, expiring index of
Pharos product evidence and open deployment gates. CI checks every evidence path and its SHA-256
snapshot, rejects self-approval, and refuses an approval claim while partial controls or blocking
gates remain. The [evidence-governance contract](security/readiness-evidence.md) explains what this
repository self-assessment proves—and what still requires an independent authority.

The current decision is **not approved**, and Pharos is **not yet a software release candidate**.
The repository has strong durability, tenancy, trusted-time, KMS, observability, deployment, and
release-assurance engineering. Production now requires and preloads hash-verified ONNX
transformer judges. Version-pinned restricted-preproduction model cards and privacy-safe,
fail-closed drift-monitoring infrastructure now exist, but independent efficacy, calibration,
reference-distribution approval, drift exercise, and production-latency approval are incomplete.
Independent penetration testing, TSA/KMS/legal
onboarding, customer-topology recovery, organizational assurance, and production validation
also remain required.

Each external owner now has a scoped [handoff packet](external-readiness/README.md) and accountable
GitHub tracker. CI verifies those trackers still exist and remain open while their gate is open.
Confidential reports stay in the approved external evidence system; the repository retains only a
schema-validated, signed receipt with immutable artifact digests and durable locators.

The evidence index maps to [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final),
[SLSA 1.2](https://slsa.dev/spec/v1.2/),
[OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/),
[CSA CCM/CAIQ 4.1](https://cloudsecurityalliance.org/artifacts/cloud-controls-matrix-v4-1),
[CSA AI-CAIQ 1.0.2](https://cloudsecurityalliance.org/artifacts/ai-consensus-assessments-initiative-questionnaire-ai-caiq),
and [NIST AI RMF 1.0](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-ai-rmf-10).
AI RMF 1.0 is under revision and must be reassessed when NIST publishes a final replacement.

The existing [SOC 2 and procurement pack](compliance/soc2-and-procurement.md) is a product control
inventory, not an attestation or completed vendor review. Run
`node scripts/verify-enterprise-readiness.mjs` before relying on this decision.
