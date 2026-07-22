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

## 3. Signing uses a local KMS (Ed25519 on disk), not AWS KMS/HSM

> **Tracking issue:** [#34](https://github.com/Bobcatsfan33/Pharos/issues/34)

**Today:** the only implemented `SigningProvider` is **local KMS** — Ed25519 keypairs held
in an on-disk keystore ([`packages/core/src/signing/localKms.ts`](../packages/core/src/signing/localKms.ts)).
It is behaviourally compatible with a real KMS (sign / verify / public-key / rotate), and key
material is confined to the keystore. `PHAROS_KMS_PROVIDER=aws-kms` is **a config enum only**:
the value parses ([`packages/config`](../packages/config/src/index.ts)) but no AWS provider
exists, and the Helm values say so
([`deploy/helm/values.yaml`](../deploy/helm/values.yaml)).

**Production:** an AWS KMS asymmetric-key `SigningProvider` (`ECC_NIST_P256` / `ECDSA_SHA_256`,
since KMS has no Ed25519), with dual-algorithm offline verification, failure-mode policy, and
a rotation runbook — roadmap tasks **S3-T1, S3-T2, S3-T3** (Vault Transit is the stretch
**S3-T4**).

## 4. Trusted-time anchoring uses a simulated TSA, not a real RFC 3161 authority

> **Tracking issue:** [#35](https://github.com/Bobcatsfan33/Pharos/issues/35)

**Today:** each chain head is timestamped and signed by an **independent signing key that
stands in for an RFC 3161 timestamp authority** — a simulated TSA
([`packages/evidence/src/timestamp.ts`](../packages/evidence/src/timestamp.ts), whose own
comment says so). The tamper-evidence property (an anchor signed by a key Pharos does not
control) is real in design, but the token is **not** a real RFC 3161 token from a third-party
TSA, so it carries no independent legal weight today.

**Production:** a real RFC 3161 client — build the `TimeStampReq` (DER/ASN.1 via `pkijs`),
POST to a configurable TSA, verify the response against the TSA cert chain, store the full
DER token, and validate it in the offline verifier; keep the simulated TSA as a `local`
provider for hermetic tests — roadmap task **S4-T1** (scheduled anchoring service: **S4-T2**).

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

## 6. The gateway holds escalated request bodies in memory (not durable across restart)

> **Tracking issue:** [#38](https://github.com/Bobcatsfan33/Pharos/issues/38)

**Today:** the zero-code HTTP gateway keeps the bodies of **escalated, held** requests in an
in-memory `Map` ([`services/gateway/src/gateway.ts`](../services/gateway/src/gateway.ts), the
`held` map). If the gateway process restarts while a request is parked awaiting a human
verdict, that held request body is lost and the agent's call cannot be resumed through the
gateway.

**Important scope:** this is **only** the gateway's transient request-body state. The
**server-side escalation record is durable in Postgres**
([`packages/storage/src/escalationStore.ts`](../packages/storage/src/escalationStore.ts)),
and the exactly-once resume guarantee is anchored on that server-side claim, not on the
in-memory map. No evidence and no verdict is lost on a gateway restart — only the parked
request body.

**Production:** a Postgres-backed `heldRequestStore` (size-capped, encrypted at rest with a
tenant data key), so a held request survives a gateway restart and forwards exactly once —
roadmap task **S8-T1** (Phase 3). Header/body fidelity and multi-target routing are **S8-T2,
S8-T3**.

---

*Maintenance: when a roadmap task above lands, delete its entry here (and the corresponding
caveat in the README/docs) in the same PR — an honest list is only honest if it shrinks as
the code catches up.*
