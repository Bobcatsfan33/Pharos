# ADR 0007 — `liability.mandateToken` (schema v1.1.1): sealing a presented MandateToken

- **Status:** Accepted with Workstream A of the
  [judgement family and primitives handoff](../handoff/2026-10-29-judgement-family-and-primitives.md).
- **Context:** ADR numbering skips 0006, reserved by the open adoption-program PR (#290).
- **Changes:** `ACTION_RECORD_SCHEMA_VERSION` 1.1.0 → **1.1.1**; one optional field.

## The need

A MandateToken is authority the agent carries: an authority block signed by the tenant's
mandate key plus attenuation blocks that can only narrow it, verifiable offline with the
published keyset. When a token is presented with an action, the record must say so in a way
that (a) a third party can audit against the token the holder keeps, (b) replay can reproduce
the verdict from the record alone, and (c) never stores the token's ephemeral secret.

## Decision

### D1 — PATCH, not MINOR

The documented rule in `packages/core/src/schema/version.ts` is explicit: an additive optional
field with no migration is a PATCH. `liability.mandateToken` is optional; records without it are
unchanged; v1.0.0 and v1.1.0 records parse and verify exactly as before. `SUPPORTED_SCHEMA_VERSIONS`
gains `"1.1.1"`; only the current version is written.

### D2 — What is sealed

```
liability.mandateToken
├─ rootKeyId     : the tenant mandate key the authority names (`mandate:<tenantId>#vN`)
├─ blockHashes[] : sha256(canonical(authority)), sha256(canonical(block 0)), …
├─ headHash      : sha256 over the token minus its proof
├─ verification  : "verified" | the structural refusal code (proof, widening, expired, …)
│                  | "root-key-unknown" | "mandate-revoked"
└─ effective?    : the authority in force after every block narrowed it (only when verified)
```

Not sealed: the token itself (it carries the holder's ephemeral secret), the signatures.
`blockHashes` and `headHash` let an auditor holding the token prove it is the one that was
presented; `effective` is what Tier 1 enforced, so it is evidence in its own right.

### D3 — A verified token supersedes the server-side mandate

`liability.mandate` becomes the effective authority rendered as a `MandateBinding`
(`limits.maxAmount`, `limits.currency`, `expiresAt`, `version: "token"`). The existing Tier-1
rules (ceiling, expiry) then apply unchanged. The token's action-type scope is enforced by a new
Tier-1 rule reading `mandateToken.effective.scope`, and is deliberately **not** copied into
`limits.actionTypes`: the structural judge keeps reading server-side mandates only until
Workstream D3 decides how judges consume tokens.

### D4 — Replay needs no token and no key

Both token rules (`mandate-token-invalid`, `mandate-token-scope`) read only the sealed
liability. Re-evaluating a record's inputs therefore reaches the same verdict without the
token, without the keyset, and without knowing whether the mandate has since been revoked —
which is exactly what a reproducibility check should mean.

### D5 — Caller cannot assert the binding (#81 holds)

`liability.mandate` is still refused on input. A token is accepted because it is *signed by the
tenant's own key*; the server verifies it against its own keyset and only then derives the
binding. `mandateId` and `mandateToken` are mutually exclusive on a request.

## Consequences

- Records sealed under 1.1.1 without a token are byte-identical in content to what 1.1.0 would
  have produced apart from the version string.
- External verifiers that hash raw `content` (the reference verifier, the Python verifier) are
  unaffected; the field is additive.
- Offline token verification proves signatures and narrowing. It cannot see revocation of the
  stored mandate; only the server checks that, at submit time, and seals `mandate-revoked`.
