# ADR 0005 — `seal.algorithm` must state the real signing algorithm (schema v1.1)

- **Status:** Proposed — design note for [#67](https://github.com/Bobcatsfan33/Pharos/issues/67).
  Implementation follows in a separate PR once this is accepted.
- **Context:** P10 threat-model reconciliation. Numbering skips 0002/0003, reserved by the
  roadmap for S9 (policy interop, Envoy).
- **Blocks:** flipping `aws-kms` to a production default.

## The defect

`sealRecord` hardcodes the seal's algorithm field:

```ts
const seal: RecordSeal = { contentHash, prevHash: params.prevHash, algorithm: "ed25519", ... };
```

and the schema *forces* that literal (`RecordSealSchema.algorithm: z.literal("ed25519")`). When
the signer is AWS KMS the actual algorithm is **ECDSA P-256**, so every such record claims
`ed25519` while the published keyset entry correctly says `ecdsa-p256`. Visible today in
[`test/fixtures/bundle-ecdsa-p256.json`](../../test/fixtures/bundle-ecdsa-p256.json).

## Two facts that determine the whole design

**1. `seal.algorithm` is not covered by the signature.** The signature is over
`signingMessageV2({ contentHash, prevHash, sequence })`, and `contentHash = sha256(content)`
where `content` does **not** include the seal. The field is unauthenticated metadata.

**2. No trusted verifier reads it.** `verifyRecord`/`verifyChain` dispatch on the *published
keyset entry* (`verify.ts:23`, `if (entry.algorithm === "ecdsa-p256")`), never on the seal. Its
only other consumer is a Postgres column.

Together: this is **not** a verification vulnerability, and correcting it cannot invalidate any
existing signature. It is a truthfulness defect in evidence that is sold as litigation-grade —
an examiner reading a record that misstates its own signature algorithm has found an
inconsistency we cannot explain away, and any third party who *naively* trusted the field
instead of the keyset would mis-dispatch.

## Decision

### D1 — Bump to schema **1.1.0**, and widen rather than replace

`ACTION_RECORD_SCHEMA_VERSION` goes to `"1.1.0"`. `RecordSealSchema.algorithm` widens from
`z.literal("ed25519")` to the existing `SignatureAlgorithm` enum (`"ed25519" | "ecdsa-p256"`).

Per the bumping rules in `schema/version.ts` this is MINOR: no field is added or removed, and
widening an enum keeps every v1.0.0 record parseable by the v1.1 reader. `sealRecord` takes the
algorithm from the signer's `PublicKeyEntry` instead of hardcoding it.

### D2 — Historical records are never rewritten or re-sealed

Records sealed under 1.0.0 keep their bytes exactly as written, including `algorithm: "ed25519"`
on ECDSA records. We do not "correct" them, even though the field is unauthenticated and we
technically could.

Rewriting stored evidence to make it look better is precisely the behaviour the WORM store,
the hash chain, and Object Lock exist to prevent. A record is a statement about what the system
did at a point in time; the misstatement is part of that history, and it is bounded, documented,
and harmless to verification. **An evidence system that edits its own past to tidy up a
cosmetic defect has destroyed the only property that made it worth having.**

### D3 — Authenticity keeps dispatching on the keyset; the new check is *consistency* only

This is the rule most easily got wrong, so it is stated explicitly.

| Property | Source of truth | Changes in v1.1? |
|---|---|---|
| **Authenticity** — does the signature verify? | The **published keyset entry's** algorithm | **No.** Never the seal field |
| **Consistency** — does the record describe itself truthfully? | `seal.algorithm` vs the keyset entry | **New**, and only for `schemaVersion ≥ 1.1` |

Dispatching verification on a self-declared field would let a record nominate the algorithm used
to check it — a real vulnerability in place of a cosmetic one. So `seal.algorithm` remains
*never* an input to signature verification. v1.1 adds a separate assertion: if the record claims
`schemaVersion ≥ 1.1` and its `seal.algorithm` disagrees with the keyset entry that verifies it,
the record is **invalid** (`algorithmMismatch`), reported as its own check alongside
`contentHashMatches` / `signatureValid` / `chainLinkValid`.

Note the version marker that gates this check *is* authenticated: `schemaVersion` lives inside
`content`, so it is hashed and signed. An attacker cannot downgrade a v1.1 record to v1.0 to
dodge the consistency check without breaking the signature.

### D4 — The read adapter treats legacy `algorithm` as informational

The v1.0 → v1.1 adapter in `packages/core/src/migration/adapters.ts` performs **no rewrite**. It
marks records with `schemaVersion < 1.1.0` such that the consistency check is skipped, and
documents the field as informational-only for those records. A mixed chain — v1.0 records
followed by v1.1 records after a deploy — must verify green end to end; that is a required test,
not an incidental one.

### D5 — Fixture strategy: add, never regenerate

- **Existing v1.0 fixtures stay byte-identical**, including `bundle-ecdsa-p256.json` with its
  misstatement. They are the regression evidence that legacy records still verify, and
  regenerating them would delete the only proof that backward verification works.
- **Add** v1.1 fixtures sealed under both Ed25519 and ECDSA P-256.
- **Add** a mixed-chain fixture spanning the version boundary.
- The offline verifier (`scripts/external-verify.ts`) must verify all three without Pharos
  infrastructure — the offline path is the whole claim, so it gates the change.

### D6 — Storage

`action_records.algorithm` already stores whatever the seal carried, so it needs no migration:
new rows record the true algorithm, old rows keep what they had. No backfill — see D2.

## Consequences

- **Good:** records become self-describing and truthful; the examiner-facing inconsistency goes
  away; a naive third-party verifier that reads the field now gets the right answer; `aws-kms` is
  unblocked as a production default.
- **Cost:** two schema versions live in the codebase simultaneously and every verification path
  must be tested against both. This is the first real exercise of the version machinery, which
  is worth doing carefully on a defect that cannot hurt anyone if we get the sequencing wrong.
- **Explicitly not solved:** v1.0 records still misstate their algorithm. That is permanent and
  intended (D2). The offline verification documentation must say so plainly rather than implying
  all records are self-describing.

## Implementation checklist (the follow-up PR)

1. `ACTION_RECORD_SCHEMA_VERSION` → `1.1.0`; widen `RecordSealSchema.algorithm` to the enum.
2. `sealRecord` takes the algorithm from the signer's `PublicKeyEntry`.
3. `verifyRecord` adds the `algorithmMismatch` check, gated on `schemaVersion ≥ 1.1.0`, and still
   dispatches signature verification on the keyset entry.
4. v1.0 → v1.1 read adapter (no rewrite) + a mixed-chain verification test.
5. New v1.1 fixtures (Ed25519 + ECDSA P-256) and a mixed-chain fixture; existing fixtures
   untouched and still green.
6. `scripts/external-verify.ts` verifies all fixtures offline.
7. Threat model §9 and `docs/schema-v1.md` updated; the register entry for #67 closed out.

## Rejected alternatives

- **Hot-patch `sealRecord` without a version bump.** Rejected by roadmap §2 rule 4, and it would
  make v1.0 records ambiguous: a reader could no longer tell whether `"ed25519"` meant Ed25519 or
  meant "written before the fix".
- **Backfill the stored column / re-seal historical records.** Rejected — see D2.
- **Dispatch verification on `seal.algorithm` once it is trustworthy.** Rejected: it is
  unauthenticated (Fact 1). Trusting it would convert a cosmetic defect into a real one.
- **Drop the field.** Rejected: removing a field from frozen v1 is a MAJOR break for every
  existing reader, to remove information rather than correct it.
