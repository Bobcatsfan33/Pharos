# EXT-OPERATIONS — production operations and recovery acceptance

Tracker: [#166](https://github.com/Bobcatsfan33/Pharos/issues/166).

SRE must exercise the immutable release candidate in the actual customer topology. The campaign
must cover installation, backup restoration, evidence-chain verification, WORM reconciliation,
AZ/region failover, measured RPO/RTO, alerts, dashboards, SLOs, capacity, judge latency, on-call,
incident escalation, customer notification, and KMS/TSA rotation.

Before candidate publication, repository administration must provide a passing live release-control
audit: the `v*` tag namespace is protected, `production-release` requires an independent reviewer,
self-review and administrator bypass are disabled, and the resulting approval record is retained.
The failed 2026-08-10 baseline is recorded in
`docs/evidence/2026-08-10-github-release-controls.md`.

Approval requires named 24x7 responders and escalation owners, timestamps and deployment identity,
observed rather than target RPO/RTO, finding/remediation records, and signed SRE acceptance.
Repository simulations and runbooks are prerequisites, not production operations evidence.
