# Issue #34 (S3-T1) — `demo:durability --verify` under `aws-kms`: run transcript

**Date:** 2026-08-02
**Repo state:** `main` @ `05d79bf3ea2b01ad86118e6a2f88e0bdf259d667`, equal to `origin/main`, clean tree.
**Purpose:** execute the two AC clauses left unverified by the P10 reconciliation comment —
`pnpm demo:durability --verify` under `aws-kms`, and the Helm values placeholder deletion.

Account identifiers and connection strings are redacted; no credentials or key material appear
in this file.

---

## 0. Preconditions

```
$ git rev-parse HEAD origin/main
05d79bf3ea2b01ad86118e6a2f88e0bdf259d667
05d79bf3ea2b01ad86118e6a2f88e0bdf259d667

$ node scripts/verify-enterprise-readiness.mjs
enterprise readiness manifest valid: 12 controls, 6 open blocking gates,
decision=not-approved, reviewBy=2026-10-29
(exit 0)
```

The readiness verifier passes and its decision fields are untouched by this work.

## 1. KMS target

A real AWS KMS asymmetric key was reachable in `us-east-1`:

```
$ aws kms describe-key --key-id alias/pharos-evidence-seal --region us-east-1 \
    --query 'KeyMetadata.[KeyId,KeyState,KeyUsage]' --output text
b2b977fd-39f1-4f8b-927e-77bcf5daaa67	Enabled	SIGN_VERIFY
# KeySpec: ECC_NIST_P256, SigningAlgorithms: [ECDSA_SHA_256]
```

**Deviation from the stated run environment:** the run was performed with the `default` AWS
profile. `AWS_PROFILE=pharos-demo` does not exist on this machine
(`aws configure list-profiles` returns only `default`).

## 2. Fresh deployment

`demo-tenant` in the primary database already held three **ed25519 / local-kms** records.
`ChainIntegrityService.verifyTenant()` verifies against `signer.publishKeyset()`, which under
`aws-kms` returns only KMS-held keys — so those Ed25519 records cannot verify under an
`aws-kms` keyset. A genuine `aws-kms` run therefore requires a chain that begins under
`aws-kms`, which is what a new operator deployment is. A scratch database was used so that no
existing evidence was modified or deleted:

```
$ docker exec pharos-postgres psql -U pharos -d pharos -c "CREATE DATABASE pharos_awskms_demo;"
CREATE DATABASE
```

## 3. The documented path, exactly as shipped

`deploy/INSTALL.md` § "Key management" and `deploy/.env.prod.example` specify the entire
operator contract as **provider + region + credentials**. No key identifier is documented and
no pre-provisioning step is described. That is precisely what was set:

```
$ export PHAROS_KMS_PROVIDER=aws-kms
$ export PHAROS_KMS_AWS_REGION=us-east-1
$ export PHAROS_PG_URL=postgres://<redacted>@localhost:5433/pharos_awskms_demo
$ npx tsx --env-file=.env scripts/demo-durability.ts

Provisioned tenant + auditor key (saved to .pharos-demo-auditor-key).

=== Submitting 3 demo actions for tenant "demo-tenant" ===
  seq 0  email.send          -> ALLOW      hash 53eb484b05aa…
  seq 1  payment.transfer    -> BLOCK      hash 4f3c11b3491c…
  seq 2  crm.update          -> ALLOW      hash c6bf14d99551…

Chain head: sequence 2 hash c6bf14d9955128ae…
Records are now durable in Postgres + WORM.
```

Confirmation that `aws-kms` was genuinely in effect (and not silently overridden by the
`local-kms` value in `.env`, which `--env-file` also loads):

```
$ docker exec pharos-postgres psql -U pharos -d pharos_awskms_demo \
    -c "select sequence, algorithm, key_id from action_records where tenant_id='demo-tenant';"
 sequence | algorithm  |        key_id
----------+------------+-----------------------
        0 | ecdsa-p256 | tenant:demo-tenant#v1
        1 | ecdsa-p256 | tenant:demo-tenant#v1
        2 | ecdsa-p256 | tenant:demo-tenant#v1
```

`ecdsa-p256` is only producible by the AWS KMS provider; `local-kms` signs `ed25519`.

## 4. AC clause — `pnpm demo:durability --verify` under `aws-kms`

```
$ npx tsx --env-file=.env scripts/demo-durability.ts --verify

=== Cold verification for tenant "demo-tenant" (simulated restart) ===
Found 3 persisted records after restart.
Genesis-to-head chain verification: PASS ✅
  records checked: 3
```

**PASS.** A cold process reconnected to the durable stores and verified the chain
genesis-to-head against public keys fetched from AWS KMS.

## 5. AC clause — Helm values placeholder note deleted

**PASS**, by inspection. `deploy/helm/values.yaml:85-92` carries operational guidance and sets
`kmsProvider: aws-kms` as the production default:

```yaml
# KMS provider: "aws-kms" (production default) or "local-kms" (development only).
#  - aws-kms: AWS KMS asymmetric keys (ECC_NIST_P256). Set PHAROS_KMS_AWS_REGION and provide
#    credentials via the standard AWS chain (IRSA / instance role / env). No keystore volume
#    needed — key material never leaves KMS.
kmsProvider: aws-kms
kmsAwsRegion: us-east-1
```

No "refuses to boot" / non-functional-enum placeholder remains anywhere in `deploy/`.

---

## 6. Finding: the provider silently self-creates KMS keys, and the pre-provisioned key is ignored

Both AC clauses pass, but the run surfaced an operator-facing defect that is **not** in the AC
and should be fixed before #34 is closed.

`AwsKms` does not accept a key identifier. It derives its own alias namespace from the tenant
key name — `alias/<aliasPrefix>/<b64url(keyName)>/v<n>` — and `ensureKey()` calls `CreateKey`
whenever no alias matches (`packages/core/src/signing/awsKms.ts:104-127`). Observed directly:

```
$ aws kms list-aliases --region us-east-1 \
    --query 'Aliases[?starts_with(AliasName, `alias/pharos`)].AliasName' --output text
alias/pharos-evidence-seal
alias/pharos/dGVuYW50OmRlbW8tdGVuYW50/v1
```

The second alias, and the CMK behind it, were **created by the demo run**. The
operator-provisioned key (`alias/pharos-evidence-seal`) was never read.

Three distinct problems:

1. **No documented identifier.** `deploy/INSTALL.md`, `deploy/.env.prod.example`,
   `deploy/helm/values.yaml`, and `docs/runbooks/key-rotation.md` never name the alias scheme
   the code computes. An operator cannot pre-provision a key that Pharos will actually use,
   because the identifier is not written down anywhere. Note this is a documentation
   **silence**, not a documented-name-vs-code-name contradiction.
2. **Implicit key creation.** First use silently mints CMKs in the customer's account under the
   default key policy, rather than binding to a key whose policy, grants, tags, and
   region/replication the customer controls. For a product whose claim is that signing keys are
   an HSM-backed trust boundary, "the application created its own signing key with a default
   policy" is a materially weaker control than "the operator provisioned a CMK and granted
   Pharos `Sign`" — and the operator is given no way to choose the latter.
3. **A security document overstates the guarantee.** `docs/security/THREAT_MODEL.md:217`
   mitigates "escalate via `ListAliases` version discovery" with the claim that *"version
   provisioning is explicit (`provisionVersion`, throws on collision)"*. That is true only of
   `provisionVersion()`. The paths an operator actually reaches — `ensureKey()` for v1 and
   `rotate()` for v(n+1) — both call the private `createVersion()` directly with no explicit
   operator step and no collision guard.

This is the same class as the #114 verifier-doc defect: an operator following the documentation
gets a result the documentation does not describe. Per the tech-lead decision on this run,
**#34 is not closed on this transcript.** The mismatch is to be fixed in its own scoped PR with
a regression pinning documentation and code to the same identifier, after which the documented
path is re-run and #34 closes on that post-fix evidence.

## 7. Cleanup note

The run created one CMK (`alias/pharos/dGVuYW50OmRlbW8tdGVuYW50/v1`) in the demo account. AWS
KMS enforces a 7–30 day pending window on key deletion; the alias can be removed immediately
with `aws kms delete-alias`. The scratch database `pharos_awskms_demo` can be dropped. Neither
the primary database nor any existing evidence was modified.
