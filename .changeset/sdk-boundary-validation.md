---
"@getpharos/sdk": minor
---

Validate submissions at the SDK trust boundary before transmit (#80).

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
