# @getpharos/sdk

## Unreleased

### Patch Changes

- `claim(tenantId, escalationId, claimId?)` now accepts a stable durable-continuation
  identity. Retrying the same identity after a crash retains claim ownership; a different
  identity is refused.

## 0.2.0

### Minor Changes

- 9ea1527: Local fail-mode is now reversibility-aware. When the platform is unreachable (including a
  `503 kms_unavailable` when the signing KMS is down), the SDK mirrors the server cascade:
  **reversible** actions fail **open** (allow, with a locally-logged stub) and **irreversible**
  actions fail **closed** (escalate), regardless of the configured `localFailMode` default
  (which still applies when an action's reversibility is unknown). Previously the single
  configured default was applied to all actions.
- 5856ed3: Validate submissions at the SDK trust boundary before transmit (#80).

  `submit()` now rejects a malformed submission with `PharosError` / `code: "invalid_input"`
  naming the offending field, instead of serializing it to the wire.

  This is a safety fix, not only faster feedback. When the platform is unreachable the SDK
  chooses a local fail-mode by reading `liability.blastRadius.reversibility` out of the
  caller's object. Previously a misspelled or mistyped field read as absent and fell through
  to the configured default, so under `localFailMode: "fail_open"` an **irreversible** action
  was locally allowed — and the server never saw it, because the server was unreachable.

  Required fields, types and enums are checked; unknown keys are still permitted so the
  server can add fields without breaking clients. No values are coerced — a numeric
  `tenantId` is an error rather than something to stringify, because silently repairing input
  would mean the sealed record is not what the caller asked to govern.

  `validateSubmitInput` is exported for callers who build a submission incrementally and want
  the same check ahead of time. The local fail-mode contract is unchanged for valid input.

### Patch Changes

- 181c293: Document escalation claims as atomic at-most-once authorization and align
  middleware errors with that protocol boundary. Gateway continuations are now
  durably encrypted and leased through Postgres, with a stable upstream
  idempotency key for crash recovery.

## 0.1.1

### Patch Changes

- Fix the published `exports` map. 0.1.0 shipped `exports` pointing at raw TypeScript source
  because the `publishConfig.exports` override is a pnpm-only feature and 0.1.0 was published
  with the npm CLI (OIDC flow); `exports` now points at `dist/` directly and the pnpm-only
  override is removed. **0.1.0 is deprecated — use >= 0.1.1.** The PyPI `getpharos` 0.1.1
  release is a version-sync with no functional change.

## 0.1.0

### Patch Changes

- Initial npm release under the `@getpharos` scope (the `pharos` npm scope and PyPI name were
  taken; the Python module name `pharos_sdk` is unchanged). Superseded by 0.1.1 — its
  `exports` map was broken (see above).
