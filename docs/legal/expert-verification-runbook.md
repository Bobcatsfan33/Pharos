# Expert-witness verification runbook

A qualified expert can certify a Pharos claims pack offline using the bundle and independently
approved TSA trust material. No Pharos service, network access, or trust in Pharos is required — the
reference implementation is the pure function `verifyClaimsPack` in
[`@pharos/evidence`](../../packages/evidence/src/claimsPack.ts), but the steps can be
re-implemented independently.

## Inputs

- `records[]` — full records and/or redacted views.
- `keyset[]` — platform tenant public keys (Ed25519, base64 SPKI).
- `tsaKeyset[]` — public keys for development-only local anchors (inside the bundle).
- `anchors[]` — trusted-time anchors over chain heads.
- `custody` — sealedBy, sealedAt, and `bundleHash`.
- Approved RFC 3161 leaf-certificate SHA-256 fingerprint(s), obtained from the contracted TSA
  or enterprise trust office through a channel independent of the bundle.

## Procedure

1. **Bundle integrity.** Recompute `sha256(canonical({meta, records, anchors}))` and confirm
   it equals `custody.bundleHash`.
2. **Full records.** For each full record: recompute `sha256(canonical(content))` and confirm
   it equals `seal.contentHash`; verify `seal.signature` over the contentHash bytes with
   `keyset[seal.keyId]`; confirm `seal.prevHash` equals the previous record's contentHash
   (the first record links to 64 zeros if it is genesis).
3. **Redacted records.** For each redacted view: for every shown field recompute
   `sha256(salt | canonical(value))` and confirm it equals the field commitment; recompute
   the disclosure root from all commitments; verify the disclosure signature over
   `sha256({disclosureRoot, contentHash})` with `keyset[keyId]`; confirm `prevHash` links to
   the previous record.
4. **Anchors.** For local anchors, verify the signature with `tsaKeyset[keyId]`. For RFC 3161,
   verify the CMS signature and signed attributes, require the timestamping EKU and certificate
   validity at `genTime`, match the message imprint to `sha256(anchor.hash)`, and match the signer
   certificate to an independently approved SHA-256 pin. Confirm at least one valid anchor's
   `hash` equals the head record's contentHash.

## Certification

If every step passes, certify: *the record set is authentic, was sealed by the holder of the
named KMS key, is unaltered and unreordered since sealing, and existed no later than the
anchored time.* Redacted fields are proven to have existed (committed) at seal time without
being revealed.

## Reference run

```bash
pnpm exec vitest run test/integration.seal.test.ts   # full incident drill + offline verify
pnpm exec vitest run test/evidence.test.ts           # redaction, timestamps, tamper detection
pnpm exec tsx scripts/external-verify.ts \
  --bundle test/fixtures/bundle-ecdsa-p256-rfc3161-anchored.json \
  --tsa-cert-sha256 32e841a95cc1164101ffde41298ef2fc75c1c4372ef095e88a6bbd47dfb191fc
```
