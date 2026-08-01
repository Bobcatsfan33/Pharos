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
| **T** | Prompt-inject the T3 judge / spoof liability | Judge input is harvested from caller-controlled `action.payload` ([`cascade.ts:274`](../../packages/cascade/src/cascade.ts)) and `liability` drives T1/T2/fail-mode. **Accepted risk [#81](https://github.com/Bobcatsfan33/Pharos/issues/81)** (trust assumption: liability is attested by trusted middleware/mandate; adversarial judge robustness is quantified in Sprint 5-7 evals) |
| **T** | Trigger injected faults in prod | **No fault path ships on the production class.** The seam moved to `FaultInjectingCascade` ([`cascade/src/testing.ts`](../../packages/cascade/src/testing.ts)), a subclass reachable only by an explicit `@pharos/cascade/testing` deep import and deliberately absent from the package index — a structural guarantee rather than the operational claim "the server never sets that field". Test: [`cascade.no-fault-hooks.test.ts`](../../test/cascade.no-fault-hooks.test.ts) |
| **R** | Dispute how a decision was reached | Citations accumulate through all tiers and are composed into the verdict ([`cascade.ts:187`](../../packages/cascade/src/cascade.ts)), then sealed — reproducible |
| **D** | Slow judge stalls the request | Deadline race ([`deadline.ts:16`](../../packages/cascade/src/deadline.ts), 800ms budget) |
| **E** | Bypass a Tier-1 block | Block short-circuits later tiers ([`cascade.ts:96`](../../packages/cascade/src/cascade.ts)); on timeout/fault the fail-mode is reversibility-aware (reversible→fail-open, else fail-closed/escalate — [`cascade.ts:221`](../../packages/cascade/src/cascade.ts)). Test: [`cascade.test.ts:127`](../../test/cascade.test.ts) |

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
| **S/R** | Evidence misstates its own signature algorithm | **Accepted risk [#67](https://github.com/Bobcatsfan33/Pharos/issues/67)** — `seal.algorithm` is hardcoded `"ed25519"` and schema-locked ([`seal.ts:36`](../../packages/core/src/chain/seal.ts), [`actionRecord.ts:164`](../../packages/core/src/schema/actionRecord.ts)) even when the signer is ECDSA P-256. **Benign for verification** because verify dispatches on the *keyset entry's* algorithm, never the seal field ([`verify.ts:23`](../../packages/core/src/chain/verify.ts)); see the dedicated analysis in §9 |
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
| **I** | Exfiltrate private key material | **AWS KMS**: private key never leaves the HSM ([`awsKms.ts:20`](../../packages/core/src/signing/awsKms.ts)). **LocalKms** stores plaintext PKCS8 in `0o600` JSON and is dev/test only; production refuses it at boot ([`config/index.ts:143`](../../packages/config/src/index.ts)) and at render ([`deployment.yaml:5`](../../deploy/helm/templates/deployment.yaml)). Tests: [`config.production.test.ts`](../../test/config.production.test.ts) "rejects local KMS" + the ci.yml helm gate "production must reject the local development KMS". Dev-only at-rest hardening: [#115](https://github.com/Bobcatsfan33/Pharos/issues/115) |
| **T** | Substitute the published keyset | Keyset is append-only; old public keys stay published so history verifies ([`awsKms.ts:210`](../../packages/core/src/signing/awsKms.ts)). Verifiers pin the keyset out of band |
| **R** | Repudiate a signature after key rotation | Rotation adds a version; old versions stay enabled for verify (§8). No record is re-signed |
| **D** | KMS outage stalls sealing | `ResilientSigner` circuit breaker fails **closed** with a distinct `kms_unavailable` (503), no partial write ([`resilience.ts:111`](../../packages/core/src/signing/resilience.ts)). Test: [`integration.kms-failmode.test.ts:116`](../../test/integration.kms-failmode.test.ts) |
| **E** | Escalate via `ListAliases` version discovery | Discovery is read-only against KMS; version provisioning is explicit (`provisionVersion`, throws on collision — [`awsKms.ts:145`](../../packages/core/src/signing/awsKms.ts)) |

See §8 for the full **rotation & compromise model**.

---

## 6. Gateway — identity & authorization (`packages/identity`, `services/api/src/auth.ts`)

| STRIDE | Threat | Mitigation (code / test) or Accepted risk |
|--------|--------|-------------------------------------------|
| **S** | Forge an API key | Keys are `pk_<id>_<secret>`; only a SHA-256 of the secret is stored, compared with `timingSafeEqual` ([`apiKeys.ts:59`](../../packages/identity/src/apiKeys.ts)). Test: [`identity.apikeys.test.ts:5`](../../test/identity.apikeys.test.ts) |
| **S** | Forge/replay a bearer token | OIDC verify checks signature, issuer allow-list, audience via JWKS ([`oidc.ts:35`](../../packages/identity/src/oidc.ts)). Test: [`identity.oidc.test.ts:97`](../../test/identity.oidc.test.ts) |
| **S** | Guess/abuse the admin token | `requireAdminToken` ([`auth.ts`](../../services/api/src/auth.ts)); 503 if unset (unconfigured is refused, never treated as "no token required"). The compare is **constant-time**: both sides are reduced to a SHA-256 digest and compared with `timingSafeEqual`, so neither a shared prefix nor the token's length is leaked by timing. Test: [`api.admin-token.test.ts`](../../test/api.admin-token.test.ts), including a source-level guard that fails if a short-circuiting compare returns. **Residual [#75](https://github.com/Bobcatsfan33/Pharos/issues/75)** — no rotation/expiry; the admin surface is provisioning-only and network-restricted in production |
| **E** | Scope / role escalation | Deny-by-default `authorize`; api-key perms are exact scopes with no role inheritance ([`principal.ts:24`](../../packages/identity/src/principal.ts)). Test: [`identity.rbac.test.ts:14`](../../test/identity.rbac.test.ts) |
| **E** | Cross-tenant escalation | Tenant mismatch denied even for admins ([`principal.ts:50`](../../packages/identity/src/principal.ts)) + RLS `FORCE` / `NOBYPASSRLS` app role ([`migrations.ts:106`](../../packages/storage/src/migrations.ts)). See [pentest-tenant-isolation.md](./pentest-tenant-isolation.md) |
| **R** | Revoked ex-employee credential reuse | Revoked keys fail verification → 401 ([`apiKeyStore.ts:61`](../../packages/storage/src/apiKeyStore.ts)). Test: [`integration.gatehouse.test.ts:171`](../../test/integration.gatehouse.test.ts) |
| **I/T** | Sniff/tamper in transit | **Accepted risk [#76](https://github.com/Bobcatsfan33/Pharos/issues/76)** — no in-app TLS/mTLS; termination expected at ingress/mesh |

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
| **S/I** | Clickjacking / no CSP / open dashboard | **Headers done**: CSP (`default-src 'self'`, `object-src 'none'`, `base-uri`/`form-action 'self'`, `frame-ancestors 'none'`), HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, Permissions-Policy, COOP, and `poweredByHeader: false` ([`next.config.mjs`](../../apps/console/next.config.mjs)); verified live against `next start` on static and dynamic routes. Test: [`console.security-headers.test.ts`](../../test/console.security-headers.test.ts). **Residual [#79](https://github.com/Bobcatsfan33/Pharos/issues/79)** — no browser auth gate, still hardwired to `demo-tenant`, and CSP retains `'unsafe-inline'` for Next's inline bootstrap and React inline styles (nonce-based CSP lands with the auth middleware before multi-tenant console GA) |
| **T** | SDK forwards unvalidated input | Server validates every submit (§1); **Accepted risk [#80](https://github.com/Bobcatsfan33/Pharos/issues/80)** — SDKs do no runtime input validation at the boundary |
| **D/R** | Platform unreachable → unrecorded action | SDK fail-mode is reversibility-aware ([`client.ts:109`](../../packages/sdk-ts/src/client.ts)); a local `fail_open` allows a reversible action with **no server evidence record** — folded into **[#81](https://github.com/Bobcatsfan33/Pharos/issues/81)** (permissive middleware default liability compounds it). Test: [`sdk.failmode.test.ts:29`](../../test/sdk.failmode.test.ts) |
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

**Disposition.** The seal is frozen schema v1 (roadmap §2 rule 4), so the fix goes through the
schema-version machinery ([`schema/version.ts`](../../packages/core/src/schema/version.ts)) with an
RFC and a v1→v1.1 read adapter treating legacy `"ed25519"` as informational-only, plus a verify-time
consistency check for `schemaVersion ≥ 1.1`. Tracked in **[#67](https://github.com/Bobcatsfan33/Pharos/issues/67)**;
**blocks flipping `aws-kms` to a production default** (does not block Sprint 4).

---

## Accepted-risk register

| ID | Risk | Surface | Disposition |
|----|------|---------|-------------|
| [#67](https://github.com/Bobcatsfan33/Pharos/issues/67) | `seal.algorithm` misstated for non-Ed25519 keys | Seal | Fix via schema v1.1 RFC; blocks aws-kms prod default |
| ~~[#73](https://github.com/Bobcatsfan33/Pharos/issues/73)~~ | ~~Rate limiter fails open on cache outage~~ | Ingestion | **Resolved** — fail-closed admission + tenant-aggregate cap, production-pinned and regression-tested |
| [#74](https://github.com/Bobcatsfan33/Pharos/issues/74) | No replay/idempotency guard on ingest | Ingestion | **Mechanism delivered** — transactional `idempotencyKey` guard. Residual: opt-in, so keyless clients remain at-least-once |
| [#75](https://github.com/Bobcatsfan33/Pharos/issues/75) | ~~Admin token: non-constant-time~~, no rotation | Gateway | **Constant-time compare done** (fix-now half). Residual: rotation/expiry still accepted |
| [#76](https://github.com/Bobcatsfan33/Pharos/issues/76) | No in-app TLS/mTLS | All | Accepted deployment dependency |
| ~~[#77](https://github.com/Bobcatsfan33/Pharos/issues/77)~~ | ~~WORM: no verify-on-read / reconcile / Object-Lock assert~~ | WORM | **Resolved** — verify-on-read, `reconcile()` implemented, fail-closed Object-Lock assertion, all regression-tested |
| [#115](https://github.com/Bobcatsfan33/Pharos/issues/115) | LocalKms plaintext keys | KMS | Dev-only residual; production refusal implemented **and regression-gated** ([#78](https://github.com/Bobcatsfan33/Pharos/issues/78) closed) |
| [#79](https://github.com/Bobcatsfan33/Pharos/issues/79) | ~~Console: no CSP/headers~~, unauthenticated, demo-tenant | Console | **Security headers done.** Residual: auth gate + per-user tenant scoping + nonce CSP, required before multi-tenant console GA |
| [#80](https://github.com/Bobcatsfan33/Pharos/issues/80) | SDKs do no runtime input validation | SDK | Accepted; server validates |
| [#81](https://github.com/Bobcatsfan33/Pharos/issues/81) | Caller-controlled liability & judge input | Cascade | Accepted pending attestation model |
| ~~[#82](https://github.com/Bobcatsfan33/Pharos/issues/82)~~ | ~~Fault-injection hooks on prod cascade class~~ | Cascade | **Resolved** — seam moved to a test-only subclass off the package index; regression-tested |

## External / human gates (not claimed here)

- **Commissioned external penetration test** — Phase 5; this document is its scoping input. The
  internal adversarial suite ([`integration.gatehouse.test.ts`](../../test/integration.gatehouse.test.ts),
  [pentest-tenant-isolation.md](./pentest-tenant-isolation.md)) gates every build but is not a
  substitute.
- **External cryptographic review** — see [crypto-review-package.md](./crypto-review-package.md).
- **SOC 2 / third-party audit** — Phase 5.
