# Limitations — the honest list

Pharos sells trust, so this file is part of the product, not an apology. It is the single
place that lists every component currently implemented as a **stand-in** for its production
version, what the stand-in actually is, and the roadmap task that replaces it. The pattern
for each entry is: *today X is implemented as Y; the production implementation is roadmap
task Z.*

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

## 1. Tier-3 judges are linear bag-of-words classifiers, not transformer judges

> **Tracking issue:** [#36](https://github.com/Bobcatsfan33/Pharos/issues/36)

**Today:** each Tier-3 "judge" is a bag-of-words (unigram + bigram) **logistic-regression
classifier** trained on a few dozen hand-written labeled examples per concern
([`packages/judge/src/model.ts`](../packages/judge/src/model.ts),
[`src/featurize.ts`](../packages/judge/src/featurize.ts)). The decision is made by learned
weights rather than hand-written patterns, but a linear model over word counts is **defeated
by paraphrase, synonym substitution, translation, or trivial obfuscation** and has near-zero
adversarial recall. This is the biggest gap in the product.

**Measured (honest baseline):** the eval harness (S5) now quantifies exactly how weak this is —
see **[docs/benchmarks/judge-evals.md](benchmarks/judge-evals.md)**. PR-AUC 68–77%; clean recall
58–99%; but **every base64/rot13-obfuscated positive is missed (adversarial recall 0%)**, and on
two concerns the judge over-flags compliant near-misses (hard-negative FPR up to 83%). Operational
precision is far below the balanced-eval figure once base rates are applied (e.g. ~0.4% adjusted
precision at 0.1% prevalence). These are real numbers with 95% intervals and negative-control
floors — the baseline Sprint 6 must beat at the frozen operating points.

**Production:** transformer judges served on CPU behind the identical cascade interface —
**gated by an eval harness that must exist first**.
- Eval harness + adversarial datasets: **S5-T1 … S5-T4** (Phase 2, Sprint 5).
- Transformer training + ONNX serving + model cards: **S6-T1 … S6-T3** (Sprint 6).
- Honest re-benchmark and drift monitoring: **S7-T1, S7-T2** (Sprint 7).

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

## 3. KMS: the default is local KMS (Ed25519 on disk); AWS KMS is implemented but not yet the default

> **Tracking issue:** [#34](https://github.com/Bobcatsfan33/Pharos/issues/34)

**Today:** an **AWS KMS `SigningProvider` is implemented** (S3-T1,
[`packages/core/src/signing/awsKms.ts`](../packages/core/src/signing/awsKms.ts)) —
`ECC_NIST_P256` / `ECDSA_SHA_256` (AWS KMS has no Ed25519), producing `ecdsa-p256` published
keys that offline verification handles alongside Ed25519. Set `PHAROS_KMS_PROVIDER=aws-kms`
plus `PHAROS_KMS_AWS_REGION` (credentials from the standard AWS chain). The provider passes
the shared `SigningProvider` conformance suite and `pnpm demo:durability --verify` runs
end-to-end under it; the "refuses to boot" placeholder is gone.

The **default remains `local-kms`** (Ed25519 in an on-disk keystore,
[`localKms.ts`](../packages/core/src/signing/localKms.ts)) — appropriate for dev and
self-hosted-without-AWS, but not an HSM boundary.

**Remaining (this phase):** KMS-unreachable failure-mode policy (**S3-T2**) and the
key-migration / rotation runbook (**S3-T3**); Vault Transit is the stretch **S3-T4**. This
entry shrinks to "default is local-kms" once those land.

## 4. Trusted-time anchoring: real RFC 3161 supported; `local` is the default for hermetic dev

> **Tracking issue:** [#35](https://github.com/Bobcatsfan33/Pharos/issues/35)

**Today (S4-T1 landed):** anchoring supports a **real RFC 3161 TSA**
([`packages/evidence/src/rfc3161.ts`](../packages/evidence/src/rfc3161.ts)) selected via
`PHAROS_TSA_PROVIDER=rfc3161` + `PHAROS_TSA_URL`. Pharos builds the `TimeStampReq` (DER/ASN.1
via `pkijs`/`asn1js`, not hand-rolled), stores the full DER `TimeStampToken`, and the token
**verifies fully offline** against its embedded TSA certificate — a third-party token that
carries independent legal weight. The default provider is still **`local`** (a simulated TSA:
a separate key stamps the time), which keeps CI and local dev hermetic; a `local` token is not
a third-party RFC 3161 token and carries no independent legal weight.

**Remaining:** the default deployment ships `local`; operators must configure a production TSA
(DigiCert/Sectigo) to get third-party weight. Scheduled per-tenant anchoring, chain-view
surfacing, and missing-anchor gap warnings are roadmap task **S4-T2**.

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

**Protocol limit:** the Pharos claim is an atomic **at-most-once authorization**, not a
distributed transaction with an arbitrary HTTP target. A crash after the target commits but
before the gateway records completion creates an ambiguous outcome. Recovery sends the
stable `Idempotency-Key: pharos-escalation-{id}` header, so an upstream that persists and
honors idempotency keys executes exactly once. An upstream that ignores the header can still
duplicate on that narrow failure boundary; claiming otherwise would be false.

**Remaining:** require and conformance-test upstream idempotency before advertising
exactly-once delivery for a connector. Header/body fidelity and multi-target routing remain
**S8-T2, S8-T3**.

---

*Maintenance: when a roadmap task above lands, delete its entry here (and the corresponding
caveat in the README/docs) in the same PR — an honest list is only honest if it shrinks as
the code catches up.*
