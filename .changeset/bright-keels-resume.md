---
"@getpharos/sdk": patch
---

Add replay-safe escalation claims: callers may pass a stable `claimId` so the same durable
continuation can recover ownership after a crash while competing identities remain refused.
