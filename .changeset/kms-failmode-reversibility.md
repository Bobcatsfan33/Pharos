---
"@getpharos/sdk": minor
---

Local fail-mode is now reversibility-aware. When the platform is unreachable (including a
`503 kms_unavailable` when the signing KMS is down), the SDK mirrors the server cascade:
**reversible** actions fail **open** (allow, with a locally-logged stub) and **irreversible**
actions fail **closed** (escalate), regardless of the configured `localFailMode` default
(which still applies when an action's reversibility is unknown). Previously the single
configured default was applied to all actions.
