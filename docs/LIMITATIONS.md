# Limitations — the honest list

Pharos sells trust, so this file is part of the product, not an apology. It is the single
place that lists every component still operating as a **stand-in** or awaiting production
promotion evidence, what exists today, and the gate that retires the limitation.

Nothing here is hidden in a code comment and contradicted in the README. If you find a
Pharos claim — in the README, the docs, a PR description, or a demo — that this file or the
code does not back, that is a **P1 bug**; please file it.

What is **not** on this list is genuinely implemented and tested: the single-transaction
verdict-and-seal invariant, hash-chained evidence with genesis-to-head verification,
offline third-party verification from the published keyset, WORM (S3 Object Lock) storage,
Postgres RLS multi-tenant isolation under a `NOBYPASSRLS` app role, the engineered
fail-open / fail-closed deadline behavior, and the CI gate that fails the build if
integration tests skip. Those claims stand.

Task IDs below reference [`docs/ROADMAP.md`](ROADMAP.md) and the enterprise engineering
roadmap.

---

## 1. Transformer judges are wired for production but not yet approved production models

> **Tracking issue:** [#36](https://github.com/Bobcatsfan33/Pharos/issues/36)

**Today:** Pharos has two explicit serving postures. Local development defaults to the
bag-of-words logistic baseline in
[`packages/judge/src/model.ts`](../packages/judge/src/model.ts). Production configuration
requires `PHAROS_JUDGE_PROVIDER=onnx`; API startup fetches or reads all three transformer
artifacts, verifies their committed SHA-256 identities, constructs every CPU inference
session, and refuses to listen if any model is missing, corrupt, or misidentified. The
cascade and policy dry-run route both use the async polymorphic registry, so there is no
linear fallback hidden behind the production configuration.

**Measured (honest baseline):** the eval harness (S5) quantifies exactly how weak the linear baseline is —
see **[docs/benchmarks/judge-evals.md](benchmarks/judge-evals.md)**. PR-AUC 68–77%; clean recall
58–99%; but **every base64/rot13-obfuscated positive is missed (adversarial recall 0%)**, and on
two concerns the judge over-flags compliant near-misses (hard-negative FPR up to 83%). Operational
precision is far below the balanced-eval figure once base rates are applied (e.g. ~0.4% adjusted
precision at 0.1% prevalence). These are real numbers with 95% intervals and negative-control
floors — the baseline Sprint 6 must beat at the frozen operating points.

The ONNX system evaluation proves serving/parity and exposes a serious known limit:
encoded/OOD input is conservatively over-flagged at the current threshold. One live
encoding evaluation is not a production efficacy approval.

Dynamic-int8 output is not cross-architecture deterministic: the same FINRA artifact produced
`0.7469` on macOS ARM and approximately `0.2287` on Linux x64 for one Spanish parity case. Pharos
therefore refuses production outside the explicitly qualified `onnxruntime-node@1.20.1/linux-x64`
target and seals `judgeRuntime` with every Tier-3 verdict. A weekly/path-triggered CI job proves
same-host Python/Node parity at `1e-4`. Cross-architecture promotion requires a separate model
qualification; it is not inferred from the content hash.

**Remaining production promotion:** independent representative and adversarial evaluation
for all three concerns, approved prevalence-adjusted operating points, OOD calibration,
independent approval of the restricted-preproduction model cards and version-pinned reference
distributions, a completed drift alert/rollback exercise, and a sustained customer-topology
latency/load run. The runtime already exports privacy-safe bounded score/drift metrics and
production fails closed when an exact active model lacks an approved profile; no reference
distribution is fabricated from the unrelated linear baseline. Until the external promotion
evidence passes, the transformer release remains pre-release and the enterprise deployment
decision remains not approved.

Related: [decision-cascade.md](decision-cascade.md), [benchmarks/latency.md](benchmarks/latency.md).

## 2. The latency benchmark was measured with the linear judges

> **Tracking issue:** [#37](https://github.com/Bobcatsfan33/Pharos/issues/37)

**Today:** the headline **p99 3.7ms at ~5,400 verdicts/sec** in
[`docs/benchmarks/latency.md`](benchmarks/latency.md) was measured with the linear judges of
item 1. It is a real measurement of the current stack, but it **must not be quoted as the
production figure** — a transformer judge on CPU raises Tier-3 latency by orders of magnitude.

**Production:** re-run and rewrite the benchmark with the real transformer judges at
realistic concurrency on a documented reference box, deleting the 3.7ms headline everywhere
it appears — roadmap task **S7-T1**. Whether the 800ms envelope holds at target concurrency
is an open question that task answers.

## 3. KMS: production requires AWS KMS; local KMS remains a development default

> **Tracking issue:** [#34](https://github.com/Bobcatsfan33/Pharos/issues/34)

**Today:** an **AWS KMS `SigningProvider` is implemented** (S3-T1,
[`packages/core/src/signing/awsKms.ts`](../packages/core/src/signing/awsKms.ts)) —
`ECC_NIST_P256` / `ECDSA_SHA_256` (AWS KMS has no Ed25519), producing `ecdsa-p256` published
keys that offline verification handles alongside Ed25519. Set `PHAROS_KMS_PROVIDER=aws-kms`
plus `PHAROS_KMS_AWS_REGION` (credentials from the standard AWS chain), and pre-provision one
customer-managed CMK per tenant at the derived alias documented in
[`deploy/INSTALL.md`](../deploy/INSTALL.md) ("Provisioning signing keys"). Key binding is
explicit: an absent key fails closed naming the alias to provision, rather than silently minting
a CMK under the AWS default key policy. The provider passes
the shared `SigningProvider` conformance suite and `pnpm demo:durability --verify` runs
end-to-end under it; the "refuses to boot" placeholder is gone.

The **local-development default remains `local-kms`** (Ed25519 in a passphrase-encrypted on-disk
keystore, [`keystore.ts`](../packages/core/src/signing/keystore.ts)) — appropriate for dev and
self-hosted evaluation, but not an HSM boundary. Entries use AES-256-GCM with a per-entry scrypt
salt, the key identity is authenticated, directory/file modes are enforced as `0700`/`0600`, and
the default lives outside the checkout. The passphrase is still a workstation secret: source it
from an OS keychain or local secret manager and back it up separately from the encrypted files.
`PHAROS_ENV=prod`, the Helm production chart, and the production Compose deployment fail closed
unless `aws-kms` is selected without an endpoint override. KMS-unreachable signing is fail closed
behind a bounded circuit breaker; the operational rotation and outage procedures are documented
in the KMS runbook.

**Remaining:** AWS KMS is the only production HSM integration; customer-managed Vault Transit
and non-AWS HSM integrations remain future portability work.

## 4. Trusted-time anchoring: real RFC 3161 supported; `local` is the default for hermetic dev

> **Tracking issue:** [#35](https://github.com/Bobcatsfan33/Pharos/issues/35)

**Today (S4-T1 landed):** anchoring supports a **real RFC 3161 TSA**
([`packages/evidence/src/rfc3161.ts`](../packages/evidence/src/rfc3161.ts)) selected via
`PHAROS_TSA_PROVIDER=rfc3161` + `PHAROS_TSA_URL`. Pharos builds the `TimeStampReq` (DER/ASN.1
via `pkijs`/`asn1js`, not hand-rolled), stores the full DER `TimeStampToken`, and verifies it
fully offline. Production also requires `PHAROS_TSA_CERT_SHA256`, obtained independently from
the contracted TSA, so an embedded certificate is not allowed to establish its own trust. The
default provider remains **`local`** only for hermetic local development.

Production configuration and manifests fail closed without RFC 3161, HTTPS, an approved
certificate pin, and a nonzero anchoring interval. Scheduled per-tenant anchoring and
missing/stale-anchor warnings are implemented. **Remaining:** contracted TSA onboarding,
pin-rotation approval, and legal validation are deployment-specific human gates.

## 5. The policy compiler is a constrained-grammar compiler (v1), not a natural-language compiler

> **Tracking issue:** [#39](https://github.com/Bobcatsfan33/Pharos/issues/39)

**Today:** [`packages/policy/src/compiler.ts`](../packages/policy/src/compiler.ts) is a
**constrained-grammar compiler**: a line-oriented grammar of roughly five plain-English
patterns (block/escalate promissory or PHI language; block/escalate/modify a subject over an
amount; require human review for a subject; block/escalate a subject when a field contains a
phrase). Anything outside those patterns is returned as `unparsed` for a human to encode.
It never auto-activates — output is candidate rules requiring approval and a dry-run.

**Production:** broader policy authoring and standards interop (Cedar / OPA-Rego) behind the
existing `evaluateArtifact` seam — roadmap task **S9-T1** (Phase 3). This is a labeling and
scope correction, not a defect: the lifecycle (compile → dry-run → shadow → active →
rollback) is genuinely implemented and tested.

## 6. Generic HTTP delivery is exactly-once only when the upstream honors idempotency

> **Tracking issue:** [#38](https://github.com/Bobcatsfan33/Pharos/issues/38)

**Today:** S8-T1 is implemented. `PostgresHeldRequestStore` encrypts the complete held
request with AES-256-GCM under an HKDF-derived tenant key, binds its tenant and escalation
id as authenticated data, enforces a 1 MiB cap, applies Postgres RLS, and leases delivery so
two gateway replicas cannot race. The production server refuses to start without Postgres
and the externally supplied master key. The integration test parks a request, replaces the
gateway process, verifies the database holds no plaintext, proves a different tenant cannot
acquire it, and resumes from a fresh instance.

**Duplicate resume is rejected** ([`integration.gateway-duplicate-resume.test.ts`](../test/integration.gateway-duplicate-resume.test.ts)),
across all three shapes: a sequential re-resume of a delivered continuation (`404`, the
successful delivery removed the row), a second resume issued at a *different* replica
(proving the guard is in Postgres, not process memory), two replicas racing recovery
(exactly one `200`, the loser refused), and an overlapping retry arriving mid-delivery
(`409`, distinct from `404` — the continuation exists, delivery is in progress). Exactly-once
rests on two independent gates and both are pinned: the held-request lease, and the
server-side `claimResume` (`resumed_at IS NULL`), which refuses a second authorization even
to a caller that bypasses the lease entirely.

**Protocol limit:** the Pharos claim is an atomic **at-most-once authorization**, not a
distributed transaction with an arbitrary HTTP target. A crash after the target commits but
before the gateway records completion creates an ambiguous outcome. Recovery sends the
stable `Idempotency-Key: pharos-escalation-{id}` header, so an upstream that persists and
honors idempotency keys executes exactly once. An upstream that ignores the header can still
duplicate on that narrow failure boundary; claiming otherwise would be false.

**Conformance gate:** the production gateway now refuses to start unless
`GATEWAY_IDEMPOTENCY_PROBE_PATH` is configured and passes
`pharos-idempotency-conformance-v1`. Pharos sends the same unique key and body twice; the
endpoint must report one execution and one stable result, and mark only the second response
with `X-Idempotency-Replayed: true`. The endpoint must use the same durable idempotency
implementation as the governed side-effect routes. This proves the configured endpoint's
observable contract; it cannot prove that a connector owner has wired a different route to
the same store.

**Remaining:** header/body fidelity and multi-target routing remain **S8-T2, S8-T3**.
Held-request encryption now uses a versioned key ring and an online,
tenant-scoped re-encryption job. Rotation is not automatic: operators must run and verify
the expand → activate → re-encrypt → contract runbook for every tenant before removing an
old key. A delivering row is intentionally skipped until its lease completes or expires.

## 7. Pharos does not terminate TLS — the host owns the front door

> **Tracking issue:** [#76](https://github.com/Bobcatsfan33/Pharos/issues/76)

**Today:** the API container listens on plain HTTP and does not implement TLS or mTLS
in-process. That is deliberate, not an omission: terminating TLS in the app would put
certificate lifecycle, cipher policy, renewal, and client-certificate verification inside
the process whose job is deciding and sealing verdicts, and would duplicate infrastructure
every serious deployment already runs.

**What Pharos owns.** The Helm chart refuses to render a production deployment unless a
terminator is *declared*. Either `ingress.enabled=true` renders the reference Ingress —
forced SSL redirect, `ssl-protocols` floor of TLS 1.3, HSTS with `includeSubDomains`, and
optional mTLS that verifies client certificates before any request reaches Pharos — or
`ingress.externalTerminator` names the component that terminates instead (mesh, cloud LB,
external gateway). TLS 1.2 is permitted only with an annotation naming who accepted it.
CI asserts the rendered manifest carries this posture and that an undeclared terminator
fails the render. The application independently requires `PHAROS_TLS_TERMINATOR` in production
and warns at boot when any other environment binds a non-loopback listener without it.

**What the host owns, and what that means.** Certificate issuance and rotation, the private
key for the serving certificate, the client CA for mTLS, and the correctness of the network
path between the terminator and the pod. **Pharos cannot verify at runtime that the declared
terminator is actually in front of it** — a cluster that deletes the Ingress after install,
or routes around it, will serve cleartext and the application will not know. The chart makes
the requirement explicit and unskippable at deploy time; it cannot make it self-enforcing at
runtime. Treat the terminator as part of your trust boundary and monitor it as such.

**Consequence for the SDKs:** `http://localhost:4000` defaults are development-only. Point
production clients at the terminator's HTTPS endpoint; both SDKs use standard
`fetch`/`urllib` with certificate verification enabled by default.

---

*Maintenance: when a roadmap task above lands, delete its entry here (and the corresponding
caveat in the README/docs) in the same PR — an honest list is only honest if it shrinks as
the code catches up.*
