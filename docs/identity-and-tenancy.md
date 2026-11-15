# Identity, RBAC, and multi-tenancy

An evidence product whose own access cannot be audited is self-refuting. This layer makes
the platform safe to expose: enterprise SSO, role-based access, hard multi-tenant
isolation with per-tenant signing keys, and a hash-chained access audit.

## Authentication

Two credential types resolve to a `Principal` ([`packages/identity`](../packages/identity/src/principal.ts)):

- **OIDC bearer (users).** `Authorization: Bearer <jwt>` is verified against a trusted
  IdP's JWKS (signature, issuer, audience, expiry). Tenant and roles come from configured
  claims. Works with any OIDC IdP; **Okta** and **Entra** are configured identically apart
  from issuer/audience/claim names ([`oidc.ts`](../packages/identity/src/oidc.ts)).
- **API keys (machine identities).** `X-API-Key: pk_<keyId>_<secret>` for SDK/gateway
  ingestion. Only a SHA-256 hash of the secret is stored; verification is constant-time.
  Keys carry explicit scopes (least privilege) and rotate without dropping traffic
  ([`apiKeys.ts`](../packages/identity/src/apiKeys.ts)).

### Wiring an IdP: worked Okta and Entra configuration

`PHAROS_OIDC_ISSUERS` is a JSON array, one entry per trusted issuer. An empty array (the
default) disables SSO bearer auth entirely and leaves API keys as the only credential.

Both snippets below are **validated against the config schema by
[`test/config.oidc-worked-examples.test.ts`](../test/config.oidc-worked-examples.test.ts)**,
which parses them out of this file — so if the doc drifts from what
[`packages/config`](../packages/config/src/index.ts) accepts, that test fails.

```json
[
  {
    "issuer": "https://acme.okta.com/oauth2/default",
    "audience": "api://pharos",
    "jwksUri": "https://acme.okta.com/oauth2/default/v1/keys",
    "claims": { "tenant": "pharos_tenant", "roles": "pharos_roles", "displayName": "name" }
  },
  {
    "issuer": "https://login.microsoftonline.com/8f3c1b2a-4d5e-6f70-8192-a3b4c5d6e7f8/v2.0",
    "audience": "api://pharos",
    "jwksUri": "https://login.microsoftonline.com/8f3c1b2a-4d5e-6f70-8192-a3b4c5d6e7f8/discovery/v2.0/keys",
    "claims": { "tenant": "extension_pharosTenant", "roles": "roles", "displayName": "name" }
  }
]
```

| Field | Okta | Entra | Notes |
|---|---|---|---|
| `issuer` | `https://<org>.okta.com/oauth2/<server>` — the custom authorization server, not the org URL, unless you use the org server | `https://login.microsoftonline.com/<tenant-guid>/v2.0` — the **v2.0** issuer; v1 tokens carry a different `iss` and will not match | Must equal the token's `iss` exactly. HTTPS is required in production. |
| `audience` | the API's audience value | the Application ID URI, e.g. `api://<app-id>` | Checked against `aud`. |
| `jwksUri` | `<issuer>/v1/keys` | `https://login.microsoftonline.com/<tenant-guid>/discovery/v2.0/keys` | Exactly one of `jwksUri` or `jwks` — inline keys are **test-only** and production refuses them. |
| `claims.tenant` | a custom claim, e.g. `pharos_tenant` | a directory extension, e.g. `extension_pharosTenant` | Required. A token without it is rejected rather than defaulted. |
| `claims.roles` | a groups/roles claim, e.g. `pharos_roles` | `roles` (app roles) | String or array; values must match the role names in [`rbac.ts`](../packages/identity/src/rbac.ts). |
| `claims.displayName` | `name` | `name` | Optional; audit entries fall back to the subject. |

Three JWKS knobs have defaults you only change under pressure: `jwksTimeoutMs` (5,000),
`jwksCooldownMs` (30,000 — how long to wait before refetching after a failure) and
`jwksCacheMaxAgeMs` (600,000). They bound how an IdP outage affects verification.

**Claim mapping is the part to get right.** Pharos does not infer a tenant. The claim named by
`claims.tenant` must carry the tenant id, and a token missing it is refused — so in Okta add
the claim to the authorization server's token policy, and in Entra add the directory extension
to the app's token configuration and ensure it is emitted on access tokens, not only id tokens.
Roles map to [`rbac.ts`](../packages/identity/src/rbac.ts) by name, and an unknown role grants
nothing rather than everything.

Production additionally requires HTTPS for both URLs, one unique entry per issuer, and remote
JWKS; `loadConfig` refuses to boot otherwise.

## RBAC — deny by default

Roles are product primitives: `tenant_admin`, `policy_author`, `reviewer`, `risk_owner`,
`counsel`, `external_auditor` (read-scoped). Each maps to a permission set
([`rbac.ts`](../packages/identity/src/rbac.ts)). Every route declares the permission it
needs; `authorize()` enforces it server-side and **rejects cross-tenant access for every
principal, including admins**. A principal with no role/scope can do nothing.

API keys resolve to *their granted scopes only* — never role inheritance — so a key is
strictly least-privilege regardless of who minted it.

Submitting a liability-bearing decision requires two capabilities: `actions:write` and
`liability:assert`. Keep `liability:assert` on the operator-controlled gateway or middleware
identity rather than the raw agent. This makes the origin of blast-radius, oversight, and
reversibility declarations an enforceable authorization boundary.

For an existing installation, mint replacement ingestion keys with both scopes through a
`keys:manage` identity, update gateways/middleware, verify the new identities, and only then route
traffic to the upgraded API. Keys carrying only `actions:write` intentionally begin receiving 403;
there is no compatibility bypass that silently restores their authority to assert risk.

## Multi-tenancy isolation (defense in depth)

1. **Application layer.** `authorize(principal, tenantId, permission)` fails closed on any
   `tenant_mismatch`.
2. **Database layer (RLS).** `action_records` and `access_audit` have `FORCE ROW LEVEL
   SECURITY` policies keyed to `current_setting('pharos.tenant_id')`. Because superusers
   bypass RLS, the application performs every tenant-scoped query inside a transaction that
   sets the tenant GUC and `SET LOCAL ROLE pharos_app` (a `NOBYPASSRLS` role). Even a query
   that *explicitly* asks for another tenant's rows returns nothing.
3. **Key + evidence layer.** Each tenant gets its own KMS signing key (`tenant:<id>`) and
   its own evidence prefix.

## Tenant lifecycle

Create, suspend, export, and delete ([`tenantStore.ts`](../packages/storage/src/tenantStore.ts)).
Deletion removes operational rows and API keys but **retains the sealed evidence chain and
WORM objects** when `retainEvidenceOnDelete` is set, honoring legal retention beyond tenant
deletion.

## Access audit

Every view, export, share, and verification of evidence is recorded as a per-tenant,
hash-chained entry ([`accessAudit.ts`](../packages/storage/src/accessAudit.ts)). The chain
is tamper-evident with the same guarantees as the evidence itself, surfaced in the Ledger
console under *Access audit*.

## Hardening

- **CORS** locked to configured origins (deny-by-default; server-to-server unaffected).
- **Rate limiting** per principal (tenant+subject), fixed-window in Redis so limits hold
  across API instances.
- **Input validation** with Zod at every boundary.
- **Bootstrap.** Tenant provisioning is a platform-operator action guarded by an admin
  token, returning a one-time tenant-admin key to seed RBAC.

## Verification

See [security/pentest-tenant-isolation.md](security/pentest-tenant-isolation.md) for the
adversarial attack-suite results, and the `integration.gatehouse` / `identity.*` test
suites for the executable proofs.
