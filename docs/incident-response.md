# Product incident and vulnerability response

This runbook covers the API, gateway, console, SDKs, PDP, evidence chain, WORM store, KMS and TSA
trust, claims packs, identity boundary, and deployment artifacts. Use the private reporting process
in [`SECURITY.md`](../SECURITY.md).

Classify cross-tenant access, authentication bypass, remote execution, signing-key compromise,
evidence-chain or WORM compromise, false trusted time, or silent fail-closed bypass as critical.
Preserve affected source, releases, receipts, image digests, SBOMs, provenance, record heads,
keysets, TSA tokens and pins, claims packs, access audit, logs, and reproduction material.

Freeze affected releases and admission allowlists. Disable compromised credentials or KMS keys
without deleting historical public-key material, rotate trust according to the KMS/TSA runbooks,
place relevant records under litigation hold, and preserve evidence before rollback, redaction, or
recovery changes state. Scope tenants, versions, keys, algorithms, TSA signers, policies, agents,
gateways, claims packs, and deployment topologies.

Require a DCO-signed fix, focused regression, normal CI/security/release gates, clean build, and
exact artifact digests. Re-run chain verification, offline bundle verification with independent
TSA trust, tenant-isolation campaigns, fail-closed behavior, KMS outage/rotation, WORM, recovery,
and admission checks relevant to the incident before restoring service.

Retain a timeline, root cause, affected-version matrix, impact, notification decision, containment
and recovery evidence, and corrective actions with owners. Named 24x7 responders, exercised
customer/regulator notification, a production incident drill, and independent retesting remain
open deployment gates.
