# Identity, RBAC, and multi-tenancy (Sprint 1 — Gatehouse)

An evidence product whose own access cannot be audited is self-refuting. Sprint 1 makes
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

## RBAC — deny by default

Roles are product primitives: `tenant_admin`, `policy_author`, `reviewer`, `risk_owner`,
`counsel`, `external_auditor` (read-scoped). Each maps to a permission set
([`rbac.ts`](../packages/identity/src/rbac.ts)). Every route declares the permission it
needs; `authorize()` enforces it server-side and **rejects cross-tenant access for every
principal, including admins**. A principal with no role/scope can do nothing.

API keys resolve to *their granted scopes only* — never role inheritance — so a key is
strictly least-privilege regardless of who minted it.

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
