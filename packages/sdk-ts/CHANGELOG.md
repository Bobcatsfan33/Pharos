# @getpharos/sdk

## Unreleased

### Patch Changes

- `claim(tenantId, escalationId, claimId?)` now accepts a stable durable-continuation
  identity. Retrying the same identity after a crash retains claim ownership; a different
  identity is refused.

## 0.3.0

### Minor Changes

- f1ec80f: MandateToken support (Workstream A): `submit({ mandateToken })` presents a portable, attenuable
  mandate; `verifyMandateToken` / `effectiveAuthority` verify one offline against the tenant's
  published mandate key (`GET /v1/keyset`, Ed25519 or ECDSA P-256); `attenuateMandateToken`
  narrows one holder-side. With `mandateToken.rootKeys` configured on the client, a structurally
  invalid token is a Tier-1 block decided locally and still submitted for sealing (`result.sealed`).
  `mandateToken.localAllow` (default `false`) enables an optimistic local allow for reversible,
  zero-amount, in-scope actions; the server's sealed verdict stays authoritative.
- dd915e3: The wire contract has one source. `@getpharos/pdp-spec` now defines the PDP vocabulary and
  exchange as zod schemas (`WIRE_SCHEMAS`, `PdpRequestSchema`, `PdpResponseSchema`, `VerdictSchema`,
  …) and publishes them as JSON Schema at `schema/pdp-v1.schema.json`; `validatePdpResponse`
  validates against the same schema. `@getpharos/sdk`'s public types (`Decision`, `Reversibility`,
  `OversightMode`, `ActionInput`, `LiabilityInput`, `BlastRadius`, `Verdict`) are derived from the
  spec package as type-only imports — the SDK still ships with zero runtime dependencies. The
  Python SDK gains `pharos_sdk.types`, generated from the JSON Schema.

### Patch Changes

- 8692a22: Add replay-safe escalation claims: callers may pass a stable `claimId` so the same durable
  continuation can recover ownership after a crash while competing identities remain refused.
- Updated dependencies [8762daf]
- Updated dependencies [dd915e3]
  - @getpharos/pdp-spec@1.1.0

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
