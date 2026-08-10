# Pharos threat model (STRIDE)

**Status:** draft for tech-lead line-by-line review (roadmap S4-T3).
**Scope:** the Pharos trust control plane as it exists on `main` today — ingestion API, verdict
cascade, seal path, WORM evidence store, KMS/signing, gateway (identity & authz), console, and the
SDKs. This is the document the Phase-5 external penetration test scopes from.

## How to read this

- Threats are organized **by surface**, each analyzed across the six **STRIDE** categories
  (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of
  privilege).
- Every row is either a **Mitigation** — a control that exists in code, linked to the exact
  `file:line` and, where possible, the test that proves it — or an **Accepted risk**, linked to a
  tracking issue. Per roadmap §2, a claim without a code/test link is not a mitigation.
- **Accepted risks require tech-lead sign-off.** Each has an issue (`#73`–`#82`, plus `#67`); the
  reviewer signs by acknowledging the issue during review.
- Verification math (hashing, signatures, chain links, RFC 3161 tokens) is reproducible **offline**
  by a third party with no Pharos access — see
  [external-verification.md](../external-verification.md) and
  [crypto-review-package.md](./crypto-review-package.md). That property is itself the strongest
  anti-tamper / anti-repudiation control and is referenced throughout.

## System overview & trust boundaries

```
 Agent / integrator
      │  (SDK: TS or Python — thin client, x-api-key)
      ▼
 ┌─────────────────────────── Pharos API (services/api) ───────────────────────────┐
 │  Gateway: authN (API key / OIDC) + authZ (scopes, tenant isolation) + rate limit │
 │      │                                                                            │
 │      ▼                                                                            │
 │  Ingestion  ──►  Verdict Cascade (T1 rules → T2 risk → T3 judges)                 │
 │      │                                                                            │
 │      ▼                                                                            │
 │  Seal path (canonicalize → sign via KMS → chain-link)                             │
 │      │                          │                                                 │
 │      ▼                          ▼                                                 │
 │  Postgres (RLS)            WORM (S3 Object Lock)      KMS (local / AWS)            │
 └──────────────────────────────────────────────────────────────────────────────────┘
      ▲
      │  read-only, server-side x-api-key
 Console (apps/console — Next.js RSC dashboard)
```

Trust boundaries (attacker crosses one to reach the next): **network → gateway**, **gateway →
tenant data**, **app role → database** (RLS), **platform → KMS private material**, **platform →
WORM immutability**, **caller-asserted liability → verdict**.

## Attacker model

| Attacker | Capability |
|----------|-----------|
| Anonymous network client | Can reach the API/console endpoints; no credential |
| Malicious tenant operator | Holds a valid credential for **their** tenant |
| Curious integrator | Holds a read-only key; tries to escalate scope |
| Compromised agent / caller | Controls `action.payload` and the asserted `liability` on submit |
| Ex-employee | Holds a **revoked** credential |
| DB-adjacent attacker | Can run SQL as the app role |
| Malicious insider (platform) | Can reach infra but not KMS private keys / WORM-locked objects |
| External auditor (honest-but-curious) | Receives an evidence bundle out of band |

---

## 1. Ingestion API (`POST /v1/actions` and evidence reads)

Route: [`services/api/src/routes/actions.ts:34`](../../services/api/src/routes/actions.ts). This is
the single mutating ingestion surface; evidence reads (`records:read`, `chain:verify`) share the
same auth path.

| STRIDE | Threat | Mitigation (code / test) or Accepted risk |
|--------|--------|-------------------------------------------|
| **S** | Forged/unauthenticated submit | `requireAuth` gates every route ([`auth.ts:75`](../../services/api/src/auth.ts)); unauth → 401. Test: [`integration.gatehouse.test.ts:131`](../../test/integration.gatehouse.test.ts) |
| **T** | Malformed/hostile payload | Zod `SubmitBodySchema` + `safeParse` → 400 ([`actions.ts:21`,`:35`](../../services/api/src/routes/actions.ts)); sub-schemas from `@pharos/core`. Body capped at 1 MiB ([`app.ts:20`](../../services/api/src/app.ts)) |
| **T** | Replay of a valid submit | Client-supplied `idempotencyKey` makes ingest exactly-once: the claim commits in the *same transaction* as the append (`ingest_idempotency`, migration `0013`), so a redelivery returns the original sealed record (`200`, `replayed: true`) and cannot seal a second. A key re-used for a different request is refused `409 idempotency_key_reuse`, never collapsed ([`actions.ts`](../../services/api/src/routes/actions.ts), [`evidenceStore.ts`](../../packages/storage/src/evidenceStore.ts)). Test: [`integration.ingest-idempotency.test.ts`](../../test/integration.ingest-idempotency.test.ts). **Residual [#74](https://github.com/Bobcatsfan33/Pharos/issues/74)** — the guard is opt-in; a client that sends no key still gets at-least-once ingest |
| **R** | "I never submitted that" | Every record is signed + chain-linked at seal (§3); the embedded `keyId` + `sealedAt` bind authorship. Offline-verifiable |
| **I** | Cross-tenant read via IDOR | `authorize` rejects tenant mismatch ([`principal.ts:50`](../../packages/identity/src/principal.ts)); RLS backstop ([`migrations.ts:106`](../../packages/storage/src/migrations.ts)). Test: [`integration.gatehouse.test.ts:114`](../../test/integration.gatehouse.test.ts) |
| **D** | Flood the ingest path | Fixed-window rate limit on two axes — per principal (default 600/min) **and per tenant in aggregate** (default 6000/min), so minting extra API keys cannot multiply a tenant's budget ([`auth.ts`](../../services/api/src/auth.ts), `withinRateLimit`). **Fails closed**: an unreachable counter store yields `503 rate_limiter_unavailable`, never unmetered admission, and production pins `api.rateLimitFailMode=closed` ([`config/index.ts`](../../packages/config/src/index.ts)). Tests: [`api.rate-limit.test.ts`](../../test/api.rate-limit.test.ts), [`config.production.test.ts`](../../test/config.production.test.ts) |
| **E** | Read-only key performs a write | Scope check denies `actions:write` ([`principal.ts:50`](../../packages/identity/src/principal.ts)). Test: [`integration.gatehouse.test.ts:137`](../../test/integration.gatehouse.test.ts) |

---

### 1a. Why the ingest idempotency guard stays opt-in ([#74](https://github.com/Bobcatsfan33/Pharos/issues/74))

The transactional guard is delivered and works. The open question was whether production
configuration should *require* `idempotencyKey`, fail-closed, the way `PHAROS_ENV=prod`
gates the KMS provider ([#78](https://github.com/Bobcatsfan33/Pharos/issues/78)) and the
gateway's durable store ([#38](https://github.com/Bobcatsfan33/Pharos/issues/38)).

**Decision: no. Opt-in is the honest posture, and this is recorded as an accepted residual.**

The reason is not convenience. It is that **requiring the field cannot enforce the property
that makes it valuable.** The guard works only when a key is *stable across redeliveries of
the same logical action* and *distinct across different actions*. Only the caller knows
which is which. A required field satisfied by `randomUUID()` on every attempt passes the
check, provides exactly zero replay protection, and makes the deployment look compliant —
strictly worse than an honest opt-in, because it converts a visible gap into an invisible one.

The two first-party callers confirm this is not hypothetical. Neither has a stable key
available:

- **The gateway** ([`gateway.ts`](../../services/gateway/src/gateway.ts)) governs arbitrary
  inbound HTTP. Absent an upstream-supplied identifier it would have to synthesise one by
  hashing the request — which would silently collapse two *intentionally* identical
  requests into one, dropping a real governed action. A missing action is a worse evidence
  defect than a duplicate one. The gateway's exactly-once story is handled at the right
  layer instead: the upstream idempotency conformance probe (`gateway.idempotencyProbePath`).
- **The framework middlewares** ([`govern.ts`](../../packages/middleware/src/govern.ts)) wrap
  a tool call with its arguments and have the same ambiguity — identical args may be two
  deliberate invocations.

**What this means in practice.** A client that retries — the common case — should supply a
key derived from its own unit of work (job id, message id, workflow step). A client that
does not gets at-least-once ingest, which is the documented pre-existing behaviour: every
delivery produces an independently valid, signed record. Duplicates remain *detectable*
(identical action payloads, adjacent sequences); they are simply not *collapsed*.

Revisit if a future first-party caller gains a naturally stable work identifier — at that
point requiring it *for that caller* becomes enforceable and therefore worth doing.

---

## 2. Verdict cascade (`packages/cascade`)

Built at [`platform.ts:172`](../../services/api/src/platform.ts); invoked on the live path at
[`actions.ts:69`](../../services/api/src/routes/actions.ts) and
[`pdp.ts:91`](../../services/api/src/routes/pdp.ts). Tiers: T1 deterministic rules
([`engine.ts:36`](../../packages/core/src/verdict/engine.ts)) → T2 risk scorer
([`riskScorer.ts:26`](../../packages/cascade/src/riskScorer.ts)) → T3 judges
([`cascade.ts:175`](../../packages/cascade/src/cascade.ts)).

| STRIDE | Threat | Mitigation (code / test) or Accepted risk |
|--------|--------|-------------------------------------------|
| **S** | Spoof a favorable verdict | Verdict is computed server-side and **sealed into the record** (§3); it cannot be asserted by the caller. Determinism test: [`cascade.test.ts:163`](../../test/cascade.test.ts) |
| **T** | Prompt-inject the T3 judge / spoof liability | Judge input is harvested from caller-controlled `action.payload` ([`cascade.ts`](../../packages/cascade/src/cascade.ts)); adversarial judge robustness is quantified in the Sprint 5–7 evals. **`liability.mandate` is server-derived and refused inline on both ingestion surfaces.** Declarative liability requires the separate `liability:assert` capability, so a raw agent can be granted `actions:write` without authority to understate risk; deployers grant assertion only to the trusted gateway/middleware identity. Tests: [`integration.mandate-forgery.test.ts`](../../test/integration.mandate-forgery.test.ts), [`integration.gatehouse.test.ts`](../../test/integration.gatehouse.test.ts). **Residual [#81](https://github.com/Bobcatsfan33/Pharos/issues/81)** — semantic payload remains hostile and accuracy of an authorized declaration remains an upstream control responsibility |
| **T** | Trigger injected faults in prod | **No fault path ships on the production class.** The seam moved to `FaultInjectingCascade` ([`cascade/src/testing.ts`](../../packages/cascade/src/testing.ts)), a subclass reachable only by an explicit `@pharos/cascade/testing` deep import and deliberately absent from the package index — a structural guarantee rather than the operational claim "the server never sets that field". Test: [`cascade.no-fault-hooks.test.ts`](../../test/cascade.no-fault-hooks.test.ts) |
| **R** | Dispute how a decision was reached | Citations accumulate through all tiers and are composed into the verdict ([`cascade.ts:187`](../../packages/cascade/src/cascade.ts)), then sealed — reproducible |
| **D** | Slow judge stalls the request | Deadline race ([`deadline.ts:16`](../../packages/cascade/src/deadline.ts), 800ms budget) |
| **E** | Bypass a Tier-1 block | Block short-circuits later tiers ([`cascade.ts:96`](../../packages/cascade/src/cascade.ts)); on timeout/fault the fail-mode is reversibility-aware (reversible→fail-open, else fail-closed/escalate — [`cascade.ts:221`](../../packages/cascade/src/cascade.ts)). Test: [`cascade.test.ts:127`](../../test/cascade.test.ts) |

### Liability trust contract ([#81](https://github.com/Bobcatsfan33/Pharos/issues/81))

`liability` is not one kind of thing. It carries a **declaration** about an action and a
**claim to authority**, and those warrant opposite treatment.

| Field | Origin | Why |
|---|---|---|
| `tenantId` | **Server-bound** | `authorize()` rejects any mismatch with the authenticated principal; a caller cannot act for another tenant |
| `liability.mandate` | **Server-derived only** | A claim to *authority*. Resolved from `mandateId` via `mandates.getActive`; supplying it inline is refused with `mandate_not_assertable` |
| `action.type`, `action.payload` | Caller-supplied | The thing being governed. Judge input is harvested from it, so it is treated as hostile by construction |
| `action.agentId`, `sessionId` | Caller-supplied | Labels within an already-authenticated tenant. Binding them to the API key would break legitimate multi-agent use of one credential |
| `blastRadius`, `oversightMode` | Capability-gated middleware assertion | Requires both `actions:write` and `liability:assert`; sealed as evidence of what that trusted machine identity declared, not as proof that the declaration was factually correct |

**Why `mandate` had to move.** The cascade stands mandate-gated controls down when a
mandate is present (`requireNoMandate`). An inline mandate therefore let a caller switch
off the control that catches unmandated funds movement — measured on the pre-fix code, an
unmandated transfer went from `escalate [finra-3110-funds-movement]` to `allow` with no
citations — and sealed the invented grant into the record as though a grantor had issued
it. Authority that the system acts on cannot be self-asserted by the party it constrains.

**What is still asserted, and what that means.** Pharos does not claim to infer whether a
blast-radius declaration is true. It requires a distinct `liability:assert` capability,
binds the declaration to that authenticated principal, and seals it immutably. Give raw
agents `actions:write` only; give `liability:assert` only to the gateway or middleware whose
configuration is controlled by the operator. A compromised assertion service can still
under-declare risk, but an ordinary ingest credential can no longer do so.

---

## 3. Seal path & chain (`packages/core/src/chain`)

`sealRecord` ([`seal.ts:21`](../../packages/core/src/chain/seal.ts)): validate → canonical hash
([`canonical.ts:16`](../../packages/core/src/chain/canonical.ts)) → sign the v2 message
([`provider.ts:82`](../../packages/core/src/signing/provider.ts)) → chain-link on `prevHash`.

| STRIDE | Threat | Mitigation (code / test) or Accepted risk |
|--------|--------|-------------------------------------------|
| **T** | Alter a record's content | Content hash recomputed on verify ([`verify.ts:100`](../../packages/core/src/chain/verify.ts)); mismatch fails. Test: [`core.seal-verify.test.ts:79`](../../test/core.seal-verify.test.ts) |
| **T** | Splice a valid record elsewhere | v2 signature binds `{sequence, prevHash, contentHash}` ([`provider.ts:82`](../../packages/core/src/signing/provider.ts)); a spliced record fails signature even if the chain link matches. Test: [`core.seal-v2.test.ts:78`](../../test/core.seal-v2.test.ts) |
| **T** | Break/reorder the chain | `verifyChain` walks genesis→head, checks sequence gaps, tenant consistency, and `prevHash` link ([`verify.ts:137`](../../packages/core/src/chain/verify.ts)). Test: [`core.seal-verify.test.ts:90`](../../test/core.seal-verify.test.ts) |
| **T** | Concurrent-append race corrupts the chain | Head row locked `FOR UPDATE` serializes appends ([`evidenceStore.ts:59`](../../packages/storage/src/evidenceStore.ts)) |
| **S/R** | Evidence misstates its own signature algorithm | **Fixed in schema v1.1.0** ([ADR 0005](../adr/0005-seal-algorithm-schema-v1-1.md), [#67](https://github.com/Bobcatsfan33/Pharos/issues/67)). `sealRecord` reads the algorithm from the signing key instead of hardcoding `"ed25519"`, and `verifyRecord` asserts it agrees with the keyset entry for `schemaVersion >= 1.1.0`. Verification still dispatches on the *keyset entry*, never the seal field ([`verify.ts`](../../packages/core/src/chain/verify.ts)) — the new check is consistency, not dispatch. Records sealed under 1.0.0 keep their misstatement by design and still verify; see §9 |
| **R** | Forge a signature | Signature verified against the published keyset ([`verify.ts:109`](../../packages/core/src/chain/verify.ts)); forged sig fails. Test: [`core.seal-verify.test.ts:100`](../../test/core.seal-verify.test.ts) |
| **T** | Non-canonical serialization desync | `canonicalize` is dependency-free, key-sorted, rejects non-finite numbers ([`canonical.ts:16`](../../packages/core/src/chain/canonical.ts)). Test: [`core.canonical.test.ts:5`](../../test/core.canonical.test.ts) |

---

## 4. WORM evidence store (`packages/storage/src/wormStore.ts`)

| STRIDE | Threat | Mitigation (code / test) or Accepted risk |
|--------|--------|-------------------------------------------|
| **T** | Overwrite/delete a sealed object | S3 **Object Lock COMPLIANCE** with a retain-until date ([`wormStore.ts:71`](../../packages/storage/src/wormStore.ts)) — immutable even to account root until expiry. Bucket created with Object Lock enabled ([`wormStore.ts:59`](../../packages/storage/src/wormStore.ts)) |
| **T** | Silent corruption of the stored body | **Verify-on-read**: `getRecord` re-derives `sha256(content)` and compares it to `seal.contentHash`, and checks the object is served under the key that addresses it — a corrupt or substituted object throws `WormIntegrityError` rather than being returned ([`wormStore.ts`](../../packages/storage/src/wormStore.ts)). `reconcile()` is implemented and surfaces orphans (benign) and **missing objects for committed records** (evidence loss, never `ok`), reachable per tenant via `EvidenceStore.reconcileWorm`. `ensureBucket` asserts Object Lock on pre-existing buckets and **fails closed** if it is absent or unconfirmable. Signature/chain verification remains `verifyRecord`/`verifyChain` against the published keyset (WORM holds no keyset). Test: [`integration.worm-integrity.test.ts`](../../test/integration.worm-integrity.test.ts) |
| **R** | "The record was fabricated later" | Retention window (default 10y) set at write ([`wormStore.ts:84`](../../packages/storage/src/wormStore.ts)); combined with RFC 3161 anchoring (§ evidence-seal) this bounds *existed-before-T* |
| **I** | Read another tenant's objects | Keys are tenant-prefixed and content-addressed ([`wormStore.ts:46`](../../packages/storage/src/wormStore.ts)); bucket access is not a tenant-facing surface (server-only credentials) |
| **D** | Write path wedges on WORM failure | WORM put happens inside the append txn; any failure rolls back with no partial record ([`evidenceStore.ts:143`](../../packages/storage/src/evidenceStore.ts)). Test: [`integration.kms-failmode.test.ts:117`](../../test/integration.kms-failmode.test.ts) |

---

## 5. KMS / signing keys (`packages/core/src/signing`)

Local (Ed25519, [`localKms.ts:36`](../../packages/core/src/signing/localKms.ts)) and AWS KMS
(ECDSA P-256, private key never leaves KMS, [`awsKms.ts:104`](../../packages/core/src/signing/awsKms.ts)).
Provider chosen at boot ([`platform.ts:89`](../../services/api/src/platform.ts)).

| STRIDE | Threat | Mitigation (code / test) or Accepted risk |
|--------|--------|-------------------------------------------|
| **S** | Sign as another key / version | keyIds are globally unique `<name>#v<n>` ([`provider.ts:54`](../../packages/core/src/signing/provider.ts)); rotation continues the sequence, never restarts. Test: [`integration.key-migration.test.ts:107`](../../test/integration.key-migration.test.ts) |
| **I** | Exfiltrate private key material | **AWS KMS**: private key never leaves the HSM ([`awsKms.ts`](../../packages/core/src/signing/awsKms.ts)). **LocalKms** is dev/test only and stores PKCS8 inside AES-256-GCM envelopes with per-entry scrypt salts and authenticated key identities; directory/file modes are repaired to `0700`/`0600`, and a passphrase is mandatory ([`keystore.ts`](../../packages/core/src/signing/keystore.ts)). Wrong secrets and ciphertext modification fail authentication; legacy plaintext entries migrate on first read ([`core.keystore.test.ts`](../../test/core.keystore.test.ts)). Production independently refuses LocalKms at boot and Helm render. |
| **T** | Substitute the published keyset | Keyset is append-only; old public keys stay published so history verifies ([`awsKms.ts:210`](../../packages/core/src/signing/awsKms.ts)). Verifiers pin the keyset out of band |
| **R** | Repudiate a signature after key rotation | Rotation adds a version; old versions stay enabled for verify (§8). No record is re-signed |
| **D** | KMS outage stalls sealing | `ResilientSigner` circuit breaker fails **closed** with a distinct `kms_unavailable` (503), no partial write ([`resilience.ts:111`](../../packages/core/src/signing/resilience.ts)). Test: [`integration.kms-failmode.test.ts:116`](../../test/integration.kms-failmode.test.ts) |
| **E** | Escalate via `ListAliases` version discovery | Discovery is read-only against KMS. Every creating path — `ensureKey`, `rotate`, `provisionVersion` — routes through `createVersion`, which throws on an existing version before issuing `CreateKey`, so no path can mint a key that collides with a published keyId ([`awsKms.ts:126`](../../packages/core/src/signing/awsKms.ts)). Implicit first-use creation is off by default and fails closed naming the alias to provision ([`awsKms.ts:160`](../../packages/core/src/signing/awsKms.ts)); operator-provisioned keys carry a customer-controlled key policy. Tests: [`docs.kms-key-identifier.test.ts`](../../test/docs.kms-key-identifier.test.ts), [`integration.aws-kms.test.ts`](../../test/integration.aws-kms.test.ts) |

See §8 for the full **rotation & compromise model**.

---

## 6. Gateway — identity & authorization (`packages/identity`, `services/api/src/auth.ts`)

| STRIDE | Threat | Mitigation (code / test) or Accepted risk |
|--------|--------|-------------------------------------------|
| **S** | Forge an API key | Keys are `pk_<id>_<secret>`; only a SHA-256 of the secret is stored, compared with `timingSafeEqual` ([`apiKeys.ts:59`](../../packages/identity/src/apiKeys.ts)). Test: [`identity.apikeys.test.ts:5`](../../test/identity.apikeys.test.ts) |
| **S** | Forge/replay a bearer token | OIDC verify checks signature, issuer allow-list, audience via JWKS ([`oidc.ts:35`](../../packages/identity/src/oidc.ts)). Test: [`identity.oidc.test.ts:97`](../../test/identity.oidc.test.ts) |
| **S** | Guess/abuse the admin token | `requireAdminToken` ([`auth.ts`](../../services/api/src/auth.ts)); 503 if unset (unconfigured is refused, never treated as "no token required"). Each compare is **constant-time**: both sides are reduced to a SHA-256 digest and compared with `timingSafeEqual`, so neither a shared prefix nor the token's length is leaked by timing. Production requires an explicit unexpired deadline; a previous credential is accepted only with its own bounded deadline for zero-downtime rotation. Tests: [`api.admin-token.test.ts`](../../test/api.admin-token.test.ts) and [`config.production.test.ts`](../../test/config.production.test.ts). Runbook: [`admin-token-rotation.md`](../runbooks/admin-token-rotation.md) |
| **E** | Scope / role escalation | Deny-by-default `authorize`; api-key perms are exact scopes with no role inheritance ([`principal.ts:24`](../../packages/identity/src/principal.ts)). Test: [`identity.rbac.test.ts:14`](../../test/identity.rbac.test.ts) |
| **E** | Cross-tenant escalation | Tenant mismatch denied even for admins ([`principal.ts:50`](../../packages/identity/src/principal.ts)) + RLS `FORCE` / `NOBYPASSRLS` app role ([`migrations.ts:106`](../../packages/storage/src/migrations.ts)). See [pentest-tenant-isolation.md](./pentest-tenant-isolation.md) |
| **R** | Revoked ex-employee credential reuse | Revoked keys fail verification → 401 ([`apiKeyStore.ts:61`](../../packages/storage/src/apiKeyStore.ts)). Test: [`integration.gatehouse.test.ts:171`](../../test/integration.gatehouse.test.ts) |
| **I/T** | Sniff/tamper in transit | Pharos does **not** terminate TLS in-process — deliberately, so certificate lifecycle, cipher policy, and client-cert verification stay out of the process that decides and seals verdicts. The assumption is now a **rendered, gated contract**: production refuses to render unless a terminator is declared, either the reference Ingress ([`ingress.yaml`](../../deploy/helm/templates/ingress.yaml): forced SSL redirect, TLS ≥1.3, HSTS, optional mTLS client-cert verification) or a named `ingress.externalTerminator`. Gated in CI by rendered-manifest assertions and negative gates (`production must reject an undeclared TLS terminator`). **Residual [#76](https://github.com/Bobcatsfan33/Pharos/issues/76)** — the host owns the terminator; Pharos cannot verify at runtime that it is actually in front of it |

*Residual, accepted by design (no issue):* API-key secrets use SHA-256 rather than a slow KDF —
acceptable because the secret is 24 bytes of CSPRNG entropy (brute-force infeasible), and the
constant-time compare removes the timing channel ([`apiKeys.ts:37`](../../packages/identity/src/apiKeys.ts)).

---

## 7. Console (`apps/console`) and SDKs (`packages/sdk-ts`, `sdks/python`)

**Console** is a read-only Next.js **server-component** dashboard; the API key stays server-side
([`api.ts:9`](../../apps/console/app/lib/api.ts)); no `"use client"`, no `dangerouslySetInnerHTML`,
no user input (no forms/params). React auto-escaping covers rendered API data.

| STRIDE | Threat | Mitigation (code / test) or Accepted risk |
|--------|--------|-------------------------------------------|
| **I** | API key leaks to the browser | Server components only; key not inlined into the client bundle (`next.config.mjs` `env` omits it). No leak in current code |
| **S/I** | Clickjacking / no CSP / open dashboard | **Authenticated, tenant-scoped, nonce-CSP.** No route renders evidence without a verified session: a navigation redirects to `/signin`, an XHR gets `401` ([`middleware.ts`](../../apps/console/middleware.ts)), and every page calls `requireSession()` — which verifies the OIDC token with the platform's own `OidcVerifier` against the same trusted issuers as the API — *before* any evidence is fetched ([`session.ts`](../../apps/console/app/lib/session.ts)). The tenant comes from the verified token claim, replacing the `demo-tenant` hardwire, and reads carry the user's own bearer token so the **API re-authorizes every request**. `script-src` uses a per-request nonce with no `'unsafe-inline'`. Static posture (HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, Permissions-Policy, COOP, `poweredByHeader: false`) stays in [`next.config.mjs`](../../apps/console/next.config.mjs). Verified live against `next start`: expired and garbage tokens both redirect, tenant-a and tenant-b sessions each see only their own tenant, and all 11 Next script tags carry the response nonce. **The policy carries no `'unsafe-*'` token at all**: the 156 inline `style` props became classes in [`globals.css`](../../apps/console/app/globals.css), so `style-src` is plain `'self'`. Equivalence was verified by rendering every page before and after and comparing text, DOM structure, and resolved declarations — all identical. Tests: [`console.auth-gate.test.ts`](../../test/console.auth-gate.test.ts) (including a source guard that fails if any `style` prop returns), [`console.security-headers.test.ts`](../../test/console.security-headers.test.ts) |
| **T** | SDK forwards unvalidated input | Server validates every submit (§1), **and both SDKs now validate before transmit** — a malformed submission raises `invalid_input` naming the field and never reaches the wire ([`validate.ts`](../../packages/sdk-ts/src/validate.ts), [`validation.py`](../../sdks/python/pharos_sdk/validation.py)). This is a safety control, not just faster feedback: when the platform is **unreachable** the SDK picks its local fail-mode from `liability.blastRadius.reversibility`, so a misspelled field previously read as absent and fell through to the configured default — under `fail_open` an *irreversible* action was locally **allowed**, with the server never able to see it. Required/typed/enum checks only (unknown keys stay permitted for forward compatibility); no coercion. Tests: [`sdk.validation.test.ts`](../../test/sdk.validation.test.ts), [`test_validation.py`](../../sdks/python/tests/test_validation.py) |
| **D/R** | Platform unreachable → unrecorded action | SDK fail-mode is reversibility-aware ([`client.ts:109`](../../packages/sdk-ts/src/client.ts)); a local `fail_open` allows an explicitly declared reversible action with **no server evidence record**. All first-party middleware and gateway defaults now declare unknown risk irreversible/human-in-loop, so absence of mapping fails closed. Test: [`sdk.failmode.test.ts:29`](../../test/sdk.failmode.test.ts), [`middleware.conformance.test.ts`](../../test/middleware.conformance.test.ts) |
| **I/T** | Plaintext HTTP defaults | SDKs use standard `fetch`/`urllib` with default TLS verification on; plaintext default is dev-only — see **[#76](https://github.com/Bobcatsfan33/Pharos/issues/76)** |

---

## 7a. Transformer-judge artifact fetch (`packages/judge/src/artifactStore.ts`)

The served transformer-judge ONNX + tokenizer blobs are GitHub Release assets (too large for git),
fetched at load time and verified against the committed manifest. This is a fetch-a-blob-from-a-
config-file-and-cache-it surface; its controls, and the two CodeQL findings dismissed as
false-positives here (so the reasoning lives in-repo, not only in the GitHub Security UI):

| STRIDE | Threat | Mitigation (code) |
|--------|--------|-------------------|
| **T** | Serve a wrong/tampered blob | Every asset is **sha256-verified against the committed manifest** before use and re-verified on read; mismatch throws and refuses to serve ([`artifactStore.ts`](../../packages/judge/src/artifactStore.ts), `ensureAsset`). The manifest hash is what `modelVersion()` pins |
| **S/SSRF** | Redirect the fetch to an attacker host | **Dismissed CodeQL `js/file-access-to-http` (FP).** The request **authority is a hardcoded constant** (`RELEASE_ORIGIN = https://github.com`); only path segments (repo/tag/asset) come from the committed manifest, each **regex-validated with the match returned** (not raw input) as a barrier. No file data can change the request host. Proven by the `badRepo` + traversal tests |
| **T** | Path-traversal / arbitrary write via the cache path | **Dismissed CodeQL `js/http-to-file-access` (FP).** The cache path is a **validated hex digest + a constant extension** — no manifest string reaches the filesystem sink (traversal test proves it) — and bytes are hash-verified before the write. Writes are **atomic (temp + rename)**, so a crash mid-write cannot leave a truncated cache file (`js/file-system-race` fixed, not dismissed) |

Dismissal-with-reason is triage, not suppression: the CodeQL queries stay **armed everywhere else in
the repo** (no config exclude) so a genuinely-unsafe future fetch/write is still caught.

---

## 8. Key rotation & compromise model

Derived from [runbooks/key-rotation.md](../runbooks/key-rotation.md); proven end-to-end by
[`integration.key-migration.test.ts`](../../test/integration.key-migration.test.ts). Two invariants
make rotation and even a full provider switch require **no data migration**:

1. **keyIds are globally unique** — never two keys named `<name>#v1` (enforced by version
   sequencing + `provisionVersion` collision guard, [`awsKms.ts:145`](../../packages/core/src/signing/awsKms.ts)).
2. **Public keys are never removed** from the published keyset — only their *signing* use ends, so
   historical records keep verifying.

**Routine rotation.** `rotate(keyName)` mints the next version and makes it active; old versions
stay enabled for verify. `verifyChain` is green across the rotation boundary.

**Compromise-triggered rotation** (STRIDE: contains a Spoofing/Repudiation blast radius):

1. Rotate immediately to a fresh key — all new records sign under it.
2. Stop signing with the compromised version (local: highest-version rule; AWS: disable `Sign` on
   the KMS key — but **never delete it or drop its public key**).
3. **Scope the blast radius** precisely: the embedded `keyId` + `sealedAt` identify records signed
   by the compromised version *during the compromise window*. Records signed before it predate the
   compromise and are unaffected.
4. **Trusted-time anchoring** (§ [evidence-seal.md](../evidence-seal.md)) gives *independent* time
   evidence — an RFC 3161 token proves which records existed before the compromise window opened,
   turning "which records can we still trust" into a verifiable question rather than an assertion.
5. File an incident; rotate the underlying credential/role; review access logs.

> The one prohibited action: deleting a key or dropping its public key. That would make honest
> historical records unverifiable — indistinguishable from tampering to a verifier.

**Provider migration & rollback** (local-kms ⇄ aws-kms) are additive and reversible; the merged
keyset verifies a mixed Ed25519/ECDSA-P256 chain offline. Note the reverse-direction rollback
collision tracked in [#68](https://github.com/Bobcatsfan33/Pharos/issues/68) (`LocalKms` needs a
`provisionVersion` to resume at the next version, mirroring the forward fix).

---

## 9. Focus: `seal.algorithm` misstatement (issue [#67](https://github.com/Bobcatsfan33/Pharos/issues/67))

**What.** `sealRecord` hardcodes `seal.algorithm: "ed25519"`
([`seal.ts:36`](../../packages/core/src/chain/seal.ts)), and the schema *forces* the literal
([`actionRecord.ts:164`](../../packages/core/src/schema/actionRecord.ts)). When the signer is AWS
KMS (ECDSA P-256), the sealed record still claims `"ed25519"`. Confirmed in
[`test/fixtures/bundle-ecdsa-p256.json`](../../test/fixtures/bundle-ecdsa-p256.json): every seal
says `ed25519` while the keyset entry says `ecdsa-p256`.

**Why it is not a verification vulnerability.** `verifyChain`/`verifyRecord` dispatch the signature
algorithm on the **published keyset entry**, never on `seal.algorithm`
([`verify.ts:23`](../../packages/core/src/chain/verify.ts)). ECDSA records verify correctly today
([`integration.aws-kms.test.ts:88`](../../test/integration.aws-kms.test.ts)). The field is
**decorative and unread** by the trusted verifier.

**Why it still matters (Spoofing-of-metadata / Repudiation).** Litigation-grade evidence that
misstates its own signature algorithm is an examiner-facing inconsistency, and any third-party
verifier that *naïvely trusted* `seal.algorithm` instead of the keyset would mis-dispatch. This is
a credibility defect in exactly the audience Pharos sells to.

**Disposition — DELIVERED in schema v1.1.0** ([ADR 0005](../adr/0005-seal-algorithm-schema-v1-1.md)).
`seal.algorithm` widened to the real algorithm and `sealRecord` reads it from the signing key;
`verifyRecord` adds a **consistency** check (`sealAlgorithmMatches`) for `schemaVersion >= 1.1.0`
while signature verification still dispatches on the **published keyset entry** — trusting a
self-declared field would let a record nominate the algorithm used to check it. The gating marker
is authenticated: `schemaVersion` is inside the hashed, signed `content`. Records sealed under
1.0.0 are **never rewritten** and still verify green, misstatement and all. Tests:
[`integration.seal-algorithm-v11.test.ts`](../../test/integration.seal-algorithm-v11.test.ts) —
real ECDSA seal under aws-kms, mismatch invalidation with the signature still valid, legacy
1.0.0 record accepted, and a mixed 1.0.0 → 1.1.0 chain. **No longer blocks `aws-kms` as a
production default.**

---

## Accepted-risk register

| ID | Risk | Surface | Disposition |
|----|------|---------|-------------|
| ~~[#67](https://github.com/Bobcatsfan33/Pharos/issues/67)~~ | ~~`seal.algorithm` misstated for non-Ed25519 keys~~ | Seal | **Resolved in schema v1.1.0** (ADR 0005). Legacy 1.0.0 records intentionally unchanged and still verify |
| ~~[#73](https://github.com/Bobcatsfan33/Pharos/issues/73)~~ | ~~Rate limiter fails open on cache outage~~ | Ingestion | **Resolved** — fail-closed admission + tenant-aggregate cap, production-pinned and regression-tested |
| [#74](https://github.com/Bobcatsfan33/Pharos/issues/74) | No replay/idempotency guard on ingest | Ingestion | **Mechanism delivered** — transactional `idempotencyKey` guard. **Decided: opt-in is the honest posture** (see §1a); a production requirement would be satisfiable by a fresh random value per attempt and would enforce nothing |
| [#75](https://github.com/Bobcatsfan33/Pharos/issues/75) | ~~Admin token: non-constant-time~~, no rotation | Gateway | **Constant-time compare done** (fix-now half). Residual: rotation/expiry still accepted |
| [#76](https://github.com/Bobcatsfan33/Pharos/issues/76) | No in-app TLS/mTLS | All | **Contract specified + independently render/runtime-gated** (`PHAROS_TLS_TERMINATOR` required in prod; non-loopback undeclared binds warn elsewhere). Residual: the host owns and monitors the actual front door |
| ~~[#77](https://github.com/Bobcatsfan33/Pharos/issues/77)~~ | ~~WORM: no verify-on-read / reconcile / Object-Lock assert~~ | WORM | **Resolved** — verify-on-read, `reconcile()` implemented, fail-closed Object-Lock assertion, all regression-tested |
| [#115](https://github.com/Bobcatsfan33/Pharos/issues/115) | LocalKms workstation-secret exposure | KMS | Encrypted at rest and permission-gated; residual is passphrase custody on the developer workstation. Production refuses LocalKms. |
| ~~[#79](https://github.com/Bobcatsfan33/Pharos/issues/79)~~ | ~~Console: no CSP/headers, unauthenticated, demo-tenant~~ | Console | **Resolved** — auth gate, per-user tenant scoping, nonce `script-src`, and `style-src 'self'` with no inline allowance anywhere |
| ~~[#80](https://github.com/Bobcatsfan33/Pharos/issues/80)~~ | ~~SDKs do no runtime input validation~~ | SDK | **Resolved** — both SDKs reject before transmit with named errors; closes the unreachable-platform fail-mode hazard |
| [#81](https://github.com/Bobcatsfan33/Pharos/issues/81) | ~~Caller-asserted mandate authority~~; liability provenance & hostile judge input | Cascade | Mandates are server-derived/refused inline on both APIs; declarative liability requires `liability:assert`; first-party unknown-risk defaults fail closed. Residual: authorized assertion accuracy and semantic-input robustness |
| ~~[#82](https://github.com/Bobcatsfan33/Pharos/issues/82)~~ | ~~Fault-injection hooks on prod cascade class~~ | Cascade | **Resolved** — seam moved to a test-only subclass off the package index; regression-tested |

## External / human gates (not claimed here)

- **Commissioned external penetration test** — Phase 5; this document is its scoping input. The
  internal adversarial suite ([`integration.gatehouse.test.ts`](../../test/integration.gatehouse.test.ts),
  [pentest-tenant-isolation.md](./pentest-tenant-isolation.md)) gates every build but is not a
  substitute.
- **External cryptographic review** — see [crypto-review-package.md](./crypto-review-package.md).
- **SOC 2 / third-party audit** — Phase 5.
