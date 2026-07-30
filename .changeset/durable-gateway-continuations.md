---
"@getpharos/sdk": patch
"@getpharos/middleware": patch
---

Document escalation claims as atomic at-most-once authorization and align
middleware errors with that protocol boundary. Gateway continuations are now
durably encrypted and leased through Postgres, with a stable upstream
idempotency key for crash recovery.
