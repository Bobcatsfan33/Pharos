---
"@getpharos/sdk": minor
---

MandateToken support (Workstream A): `submit({ mandateToken })` presents a portable, attenuable
mandate; `verifyMandateToken` / `effectiveAuthority` verify one offline against the tenant's
published mandate key (`GET /v1/keyset`, Ed25519 or ECDSA P-256); `attenuateMandateToken`
narrows one holder-side. With `mandateToken.rootKeys` configured on the client, a structurally
invalid token is a Tier-1 block decided locally and still submitted for sealing (`result.sealed`).
`mandateToken.localAllow` (default `false`) enables an optimistic local allow for reversible,
zero-amount, in-scope actions; the server's sealed verdict stays authoritative.
