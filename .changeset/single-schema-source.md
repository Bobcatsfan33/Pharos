---
"@getpharos/pdp-spec": minor
"@getpharos/sdk": minor
---

The wire contract has one source. `@getpharos/pdp-spec` now defines the PDP vocabulary and
exchange as zod schemas (`WIRE_SCHEMAS`, `PdpRequestSchema`, `PdpResponseSchema`, `VerdictSchema`,
…) and publishes them as JSON Schema at `schema/pdp-v1.schema.json`; `validatePdpResponse`
validates against the same schema. `@getpharos/sdk`'s public types (`Decision`, `Reversibility`,
`OversightMode`, `ActionInput`, `LiabilityInput`, `BlastRadius`, `Verdict`) are derived from the
spec package as type-only imports — the SDK still ships with zero runtime dependencies. The
Python SDK gains `pharos_sdk.types`, generated from the JSON Schema.
