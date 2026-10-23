# External verification walkthrough

This is the procedure a third party (auditor, opposing counsel's expert, insurer)
follows to validate a Pharos evidence chain **without trusting Pharos infrastructure**.
It requires only two inputs, an evidence bundle delivered out of band:

1. **Records** — the tenant's `ActionRecord`s as JSON, ordered by `sequence`.
2. **Keyset** — the published public keys (`keyId → { publicKey, algorithm }`, where
   `algorithm` is `ed25519` or `ecdsa-p256`).

No database, no Pharos service, and no secret material are needed. The verifier
reimplements the algorithm below (or runs the reference implementation in
[`@pharos/core`](../packages/core/src/chain/verify.ts), which is pure and has no
infrastructure dependencies).

## The algorithm

For each record, in `sequence` order starting at 0:

1. **Schema** — the record conforms to ActionRecord v1 (see [schema-v1.md](./schema-v1.md)).
2. **Content hash** — compute `sha256(canonical(record.content))` and confirm it equals
   `record.seal.contentHash`. Canonicalization = sorted object keys, minified, arrays in
   order, `undefined` dropped.
3. **Signature** — base64-decode `record.seal.signature` and verify it over the seal's
   signing message with the keyset entry for `record.seal.keyId`. The message depends on
   `record.seal.sigVersion`:
   - **v2 (current; `sigVersion === 2`)** — the UTF-8 bytes of
     `pharos:record-seal:v2\n{sequence}\n{prevHash}\n{contentHash}`: the fixed prefix
     line, the decimal `record.content.sequence`, the 64-hex `seal.prevHash`, and the
     64-hex `seal.contentHash`, joined by single `\n` newlines. Signing the chain
     position means a record cannot be spliced into another position or tenant.
   - **v1 (legacy; `sigVersion` absent or `1`)** — the ASCII bytes of the 64-char hex
     `record.seal.contentHash` only. Records sealed before v2 still verify this way.

   The verification primitive is chosen by the **keyset entry's** `algorithm` — not by
   `record.seal.algorithm`, which is a known misstatement
   ([issue #67](https://github.com/Bobcatsfan33/Pharos/issues/67)): `ed25519` verifies the
   raw 64-byte signature directly over the message (no digest); `ecdsa-p256` (AWS KMS)
   verifies a DER-encoded signature over SHA-256 of the message. Reference:
   `sealSigningMessage` / `signingMessageV2` in
   [`provider.ts`](../packages/core/src/signing/provider.ts), the dispatch in
   [`verify.ts`](../packages/core/src/chain/verify.ts), and
   [crypto-review-package.md §5](./security/crypto-review-package.md#5-seal-signature--v1-vs-v2),
   which includes a runnable hand-verification recipe.
4. **Chain link** — confirm `record.seal.prevHash` equals the previous record's
   `contentHash` (for `sequence 0`, the genesis hash of 64 zeros).
5. **Sequence** — confirm `sequence` increments by exactly 1 with no gaps, and all
   records share one `tenantId`.

If every record passes, the chain is intact from genesis to head: no record was altered,
inserted, removed, or reordered after sealing. Because signatures are asymmetric, only
the holder of the KMS private key could have produced them — and that key never leaves
the KMS.

## Reference run

With the platform running (`pnpm api:up` equivalents) and demo data sealed:

```bash
pnpm infra:up
pnpm demo:durability            # seal demo records
pnpm api:dev &                  # serve the API
pnpm verify:external demo-tenant
```

If counsel, an auditor, or an insurer receives an out-of-band evidence bundle,
they can verify it with no Pharos service running:

```bash
pnpm verify:bundle ./evidence-bundle.json
```

The offline bundle format is intentionally small:

```json
{
  "tenantId": "tenant-a",
  "records": ["<ActionRecord>", "..."],
  "keyset": ["<PublicKeyEntry>", "..."]
}
```

Two further top-level keys are **optional** (see the `EvidenceBundle` type in
[`scripts/external-verify.ts`](../scripts/external-verify.ts)): `anchors` — trusted-time
anchors over chain heads, either local-signed or RFC 3161 timestamp tokens — and `tsaKeyset`
— the published TSA public keys needed to check `local` anchors (RFC 3161 tokens self-verify
against the pinned TSA certificate). Chain verification needs neither; they add trusted time.
The signed fixture bundles in
[crypto-review-package.md](./security/crypto-review-package.md) show both shapes.

Expected output:

```
=== External verification of tenant "demo-tenant" (offline, zero-trust) ===
Fetched 3 records and 1 public keys.
Verifying with @pharos/core ONLY (no DB, no signer, no platform calls)…

  ✅ seq   0  hash:ok sig:ok link:ok
  ✅ seq   1  hash:ok sig:ok link:ok
  ✅ seq   2  hash:ok sig:ok link:ok

Chain verification: PASS ✅ — admissible
```

The verifier script ([`scripts/external-verify.ts`](../scripts/external-verify.ts))
fetches the bundle over HTTP only for convenience when `--bundle` is not provided;
the verification itself calls
`verifyChain(records, keyset)` from `@pharos/core` and touches nothing else. Tamper with
any record body and re-run: the corresponding line flips to `hash:BAD` and the chain
fails — demonstrated by the `core.seal-verify` and `integration.durability` test suites.

## Key rotation

Rotating a signing key mints a new `keyId` (`<name>#v2`, `#v3`, …) while prior versions
remain in the published keyset. Each record embeds the `keyId` that signed it, so records
signed before and after a rotation both verify — chain continuity is preserved across
rotations. See the `core.signing` test suite.
