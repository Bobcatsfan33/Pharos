# EXT-OPERATIONS — production operations and recovery acceptance

Tracker: [#166](https://github.com/Bobcatsfan33/Pharos/issues/166).

SRE must exercise the immutable release candidate in the actual customer topology. The campaign
must cover installation, backup restoration, evidence-chain verification, WORM reconciliation,
AZ/region failover, measured RPO/RTO, alerts, dashboards, SLOs, capacity, judge latency, on-call,
incident escalation, customer notification, and KMS/TSA rotation.

Approval requires named 24x7 responders and escalation owners, timestamps and deployment identity,
observed rather than target RPO/RTO, finding/remediation records, and signed SRE acceptance.
Repository simulations and runbooks are prerequisites, not production operations evidence.
