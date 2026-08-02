# @getpharos/middleware

## 0.1.1

### Patch Changes

- 181c293: Document escalation claims as atomic at-most-once authorization and align
  middleware errors with that protocol boundary. Gateway continuations are now
  durably encrypted and leased through Postgres, with a stable upstream
  idempotency key for crash recovery.
- Updated dependencies [181c293]
- Updated dependencies [9ea1527]
- Updated dependencies [5856ed3]
  - @getpharos/sdk@0.2.0
