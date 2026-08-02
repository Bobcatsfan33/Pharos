# Issue #34 (S3-T1) — post-fix verification of the documented `aws-kms` path

**Date:** 2026-08-02
**Companion to:** `2026-08-02-issue-34-aws-kms-durability.md`, which recorded the pre-fix run and
the key-identifier finding. This document records the re-run **after** that finding was fixed.
**Purpose:** close #34 on the documented path working as documented, not on a hand-arranged key
placement.

Account identifiers and connection strings are redacted; no credentials or key material appear
in this file.

---

## 1. What was wrong

The pre-fix run passed both AC clauses but showed that `AwsKms` accepted no key identifier: it
derived `alias/<prefix>/<b64url(keyName)>/v<n>` internally, and `ensureKey()` called `CreateKey`
whenever nothing matched. The operator-provisioned key was ignored, the identifier Pharos
actually used was documented nowhere, and CMKs were minted under the **AWS default key policy**.
`docs/security/THREAT_MODEL.md:217` additionally claimed version provisioning was explicit when
the operator-reachable paths were not.

## 2. Which side was changed, and why

**The code was changed, and the docs were written to match it — not the reverse.**

The reviewing preference was to have the provider consume an explicitly configured key
identifier. That contract does not fit: signing keys are **per tenant** (`tenant:<id>#v<n>`, from
`TenantStore.kmsKeyName`), so there is no single ARN to configure, and a per-tenant map in
environment configuration would be worse than the derivation it replaced. What the preference was
actually protecting — *explicit over magic* — is preserved instead by making the derived alias a
**documented, operator-facing contract** and refusing to act on it implicitly:

- `awsKmsAliasName()` is now exported, so the derivation is a published contract rather than an
  implementation detail.
- `ensureKey()` **fails closed by default**. `AwsKmsConfig.allowKeyCreation` defaults to `false`.
- The refusal is self-documenting: it names the exact alias to provision *and* the flag that
  would permit implicit creation.
- `deploy/INSTALL.md` § "Provisioning signing keys" documents the derivation end to end, with a
  worked example and the customer-controlled key policy to attach (`kms:Sign` +
  `kms:GetPublicKey` only).
- `test/docs.kms-key-identifier.test.ts` pins the documentation to the code so they cannot drift.

`rotate()` and `provisionVersion()` are unchanged in availability — they are explicit operator
actions by definition, and the rotation runbook still works.

### On the THREAT_MODEL claim: the claim was made true

The standing rule is make-it-true or make-it-accurate, no silent middle. **Made true.** The
collision guard was moved into the private `createVersion()`, which every creating path
(`ensureKey`, `rotate`, `provisionVersion`) routes through, so "throws on collision" now holds
for all of them rather than only `provisionVersion`. It is checked *before* `CreateKey` so a
refusal cannot strand an unaliased CMK in the operator's account. The claim was small enough to
honour, and honouring it is worth more than narrowing the sentence. The row was also updated to
describe the new fail-closed default, since the old text no longer described the whole
mitigation.

## 3. Post-fix run — refusal path (real AWS, `us-east-1`)

An unprovisioned tenant now fails closed instead of silently minting a CMK:

```
expected alias: alias/pharos/dGVuYW50OmFjbWU/v1

refusal:
aws-kms: no signing key for "tenant:acme" and implicit key creation is disabled.
Pre-provision a customer-managed CMK (KeySpec ECC_NIST_P256, KeyUsage SIGN_VERIFY) and alias it
"alias/pharos/dGVuYW50OmFjbWU/v1", granting this principal kms:Sign and kms:GetPublicKey — or set
PHAROS_KMS_AWS_ALLOW_KEY_CREATION=true to let Pharos mint it under the AWS default key policy.
See deploy/INSTALL.md "Provisioning signing keys".
```

The alias in the refusal is byte-identical to the worked example in `deploy/INSTALL.md`, which is
what `docs.kms-key-identifier.test.ts` enforces. **No key was created by this run.**

## 4. Post-fix run — AC clause, `pnpm demo:durability --verify` under `aws-kms`

Fresh deployment (`pharos_awskms_postfix`), `aws-kms`, **implicit creation left at its new
default of disabled**, binding to the key already present at the derived alias:

```
$ export PHAROS_KMS_PROVIDER=aws-kms PHAROS_KMS_AWS_REGION=us-east-1
$ npx tsx --env-file=.env scripts/demo-durability.ts
  seq 0  email.send          -> ALLOW      hash 6af4b8a1055d…
  seq 1  payment.transfer    -> BLOCK      hash cf89ed8c3fa4…
  seq 2  crm.update          -> ALLOW      hash 567f8e39efd1…
Chain head: sequence 2 hash 567f8e39efd1710a…

$ npx tsx --env-file=.env scripts/demo-durability.ts --verify
=== Cold verification for tenant "demo-tenant" (simulated restart) ===
Found 3 persisted records after restart.
Genesis-to-head chain verification: PASS ✅
  records checked: 3
```

**PASS**, on the documented path with the fail-closed default in force. Confirmed no key was
minted — the account's `alias/pharos*` set is unchanged across the whole post-fix run:

```
alias/pharos-evidence-seal
alias/pharos/dGVuYW50OmRlbW8tdGVuYW50/v1
```

## 5. Suite state

`pnpm -r typecheck` clean. `pnpm test`: **68 files, 472 tests, 0 skips** (was 464; +5 docs↔code
pins, +3 provisioning-contract tests). `pnpm lint` and `prettier --check` clean.

The three new provisioning tests run against the KMS emulator and cover what the real-AWS runs
above cannot cheaply demonstrate twice: that a strict provider binds to a **pre-provisioned** key
without creating one, and that a version collision throws instead of minting a duplicate keyId.

## 6. Accepted, not fixed: the demo signed as IAM root

The pre-fix run used the `default` AWS profile, which is **IAM root** for the demo account,
because `AWS_PROFILE=pharos-demo` was never written — the rotation block that would have created
it was not run. Signing demos as root is a real weakness and is recorded here rather than
silently dropped. It is **accepted for now**: there is no buyer driving the demo account's
posture, so further spend on it is not justified. Revisit when there is.

Related and closed out in the same pass: the leaked access key on the `pharos-demo` IAM user was
retired (`aws iam delete-access-key`). It had **never been used** — `GetAccessKeyLastUsed`
returned `LastUsedDate: None` — and nothing the demo used depended on it. That user now has zero
access keys.

## 7. Standing artifacts

Left in place deliberately as the finding's evidence, and safe to remove at the reviewer's
discretion:

- CMK behind `alias/pharos/dGVuYW50OmRlbW8tdGVuYW50/v1` — created by the **pre-fix** run under
  the AWS default key policy. Both scratch chains verify against it, so deleting the key makes
  those transcripts unreproducible; AWS also enforces a 7–30 day pending window on key deletion.
- Scratch databases `pharos_awskms_demo` (pre-fix) and `pharos_awskms_postfix` (post-fix).
- `alias/pharos-evidence-seal` was removed after #34 closed: the finding established it was never
  the identifier the software consumes, and leaving it invites the same mistake again.

Neither the primary database nor any pre-existing evidence was modified at any point.
