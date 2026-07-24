# Runbook: signing-key rotation & provider migration (S3-T3)

Every evidence record embeds the **keyId** that signed it (`<keyName>#v<n>`), and the published
keyset is **append-only**. Two invariants follow, and this runbook depends on both:

1. **keyIds are globally unique.** There is never more than one key called `<name>#v1`.
2. **Old keys are never removed from the published keyset** — only their _signing_ use ends.
   Their public keys remain published forever so historical records keep verifying.

Because of these, rotation and even a full KMS-provider switch need **no data migration**: old
records are untouched and verify under their old public keys; new records sign under the new
key; the merged keyset verifies the whole chain genesis-to-head. Proven end-to-end in
`test/integration.key-migration.test.ts`.

---

## 1. Scheduled (routine) rotation

Rotate a tenant's signing key on a schedule (e.g. annually, or per policy).

```ts
const newKeyId = await signer.rotate(keyName); // e.g. tenant:acme -> tenant:acme#v3
```

- `rotate()` mints a **new version** and makes it active. New records sign under it.
- **Old versions stay enabled for verify** and stay in `publishKeyset()`. No record is re-signed.
- Nothing else changes: chain verification uses the (now larger) keyset; `verifyChain` is green
  across the rotation boundary.

**Verify after rotating:** run `pnpm verify:external <tenant>` (or `--bundle`) — the chain
verifies genesis-to-head with the merged keyset.

## 2. Compromise-triggered rotation

If a signing key (or the keystore/KMS credential) is suspected compromised:

1. **Rotate immediately** to a fresh key: `await signer.rotate(keyName)`. All new records now
   sign under the new key.
2. **Stop signing with the compromised version.** With local-kms, the active version is always
   the highest, so a rotate suffices. With aws-kms, additionally disable the compromised KMS key
   for `Sign` in the AWS console/API — but **do NOT delete it or remove its public key from the
   keyset**: records legitimately signed before the compromise window must remain verifiable.
3. **Scope the blast radius.** Records signed by the compromised version _during the compromise
   window_ are suspect; records signed before it are not (they predate the compromise). The
   embedded keyId + `sealedAt` bound the affected set precisely.
4. **Anchoring** (S4) gives independent time evidence for when records existed; use it to argue
   which records predate the compromise.
5. File an incident; rotate the underlying credential/role; review access logs.

> Deleting a key or dropping its public key is the one thing you must not do — it would make
> honest historical records unverifiable, which is indistinguishable from tampering to a verifier.

## 3. Provider migration: local-kms → aws-kms (no data migration)

Migrating a live tenant chain from local-kms (Ed25519) to aws-kms (ECDSA P-256):

**The critical rule — continue the version sequence.** keyIds must stay globally unique, so the
new aws-kms key for a keyName must take the **next** version, not restart at v1. Both providers
independently default a fresh keyName to `#v1`, so a naive switch would create two different keys
both called `<name>#v1` and break the merged keyset. Provision the aws-kms key at the next
version instead:

```ts
// keyName already exists under local-kms at v1 (Ed25519).
const localMax = parseKeyId(await localKms.activeKeyId(keyName)).version; // 1
const awsKeyId = await awsKms.provisionVersion(keyName, localMax + 1);     // tenant:acme#v2 (ECDSA P-256)
```

Then:

1. **Switch the platform** to `PHAROS_KMS_PROVIDER=aws-kms` (+ region/credentials). New records
   sign under `#v2` (ECDSA P-256).
2. **Publish the merged keyset**: old Ed25519 public keys (from the retired local-kms keystore's
   published keyset) **plus** the new aws-kms public keys. The keyset is additive; nothing is
   removed. Keep the local-kms keystore's public keyset available for verification (it's public;
   no private material is needed).
3. **No records are re-signed or re-written.** Old records still name their Ed25519 `#v1` keyId;
   new records name the ECDSA `#v2` keyId. `verifyChain` dispatches per-record on the key's
   algorithm and is green genesis-to-head.

**Verify:** the offline verifier (`scripts/external-verify.ts`, which uses the same
`verifyChain`) validates the mixed chain from the merged keyset with no Pharos infrastructure —
Ed25519 records and ECDSA P-256 records alike.

### Migrating multiple keyNames / rotation state

If a keyName had been rotated under local-kms (e.g. up to `#v3`), provision the aws-kms key at
`localMax + 1` for that keyName (`#v4`). Repeat per keyName. The retired local-kms public keys
stay in the published keyset.

## 4. Rollback

A provider switch is reversible because it adds, never removes: to roll back, point
`PHAROS_KMS_PROVIDER` back at local-kms. Records signed under aws-kms keep verifying (their ECDSA
public keys remain in the published keyset); new records sign under local-kms again at the next
version. Keep both providers' public keysets published.
