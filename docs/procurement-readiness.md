# Enterprise procurement and deployment decision

[`enterprise-readiness.json`](enterprise-readiness.json) is the authoritative, expiring index of
Pharos product evidence and open deployment gates. CI checks every evidence path and refuses an
approval claim while partial controls or blocking gates remain.

The current decision is **not approved**, and Pharos is **not yet a software release candidate**.
The repository has strong durability, tenancy, trusted-time, KMS, observability, deployment, and
release-assurance engineering. Production now requires and preloads hash-verified ONNX
transformer judges, but their independent efficacy, calibration, drift, model-card, and
production-latency approval is incomplete. Independent penetration testing, TSA/KMS/legal
onboarding, customer-topology recovery, organizational assurance, and production validation
also remain required.

The evidence index maps to [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final),
[SLSA 1.2](https://slsa.dev/spec/v1.2/),
[OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/),
[CSA CCM/CAIQ 4.1](https://cloudsecurityalliance.org/artifacts/cloud-controls-matrix-v4-1),
[CSA AI-CAIQ 1.0.2](https://cloudsecurityalliance.org/artifacts/ai-consensus-assessments-initiative-questionnaire-ai-caiq),
and [NIST AI RMF 1.0](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-ai-rmf-10).
AI RMF 1.0 is under revision and must be reassessed when NIST publishes a final replacement.

The existing [SOC 2 and procurement pack](compliance/soc2-and-procurement.md) is a product control
inventory, not an attestation or completed vendor review. Run
`python3 scripts/verify_enterprise_readiness.py` before relying on this decision.
