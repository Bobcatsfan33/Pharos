# Pharos cryptographic review package

**Audience:** an external cryptographer / security reviewer with no prior exposure to this
codebase.
**Goal (and acceptance test):** using only this document and the committed fixtures, you can
**re-verify a sample evidence bundle by hand in under a day** — recompute a content hash, check a
signature, walk the chain link, verify a redacted view, and validate a real RFC 3161 timestamp —
**with no Pharos infrastructure, no database, and no secret material.**

Everything here is offline. If a step requires a running service, it is optional and clearly
marked.

---

## 1. What you have

Committed, self-contained fixtures under [`test/fixtures/`](../../test/fixtures/):

| Fixture | What it is |
|---------|-----------|
| [`bundle-ed25519.json`](../../test/fixtures/bundle-ed25519.json) | 4-record chain signed with **Ed25519**, + published keyset |
| [`bundle-ecdsa-p256.json`](../../test/fixtures/bundle-ecdsa-p256.json) | 4-record chain signed with **ECDSA P-256** (AWS-KMS-shaped), + keyset |
| [`bundle-ecdsa-p256-rfc3161-anchored.json`](../../test/fixtures/bundle-ecdsa-p256-rfc3161-anchored.json) | The ECDSA chain **plus a real RFC 3161 timestamp** over the head |
| [`rfc3161-token.json`](../../test/fixtures/rfc3161-token.json) | A standalone real FreeTSA `TimeStampToken` (base64 DER) + the value it stamps |

Bundle shape (top-level keys): `tenantId`, `algorithm`, `records[]`, `keyset[]`, and (anchored
bundle only) `anchors[]`, `tsaKeyset[]`.

The **reference implementation** of every algorithm below is pure and dependency-light:
[`packages/core/src/chain/`](../../packages/core/src/chain/) and
[`packages/evidence/src/rfc3161.ts`](../../packages/evidence/src/rfc3161.ts). You are encouraged to
re-implement from this spec and diff against it.

---

## 2. Primitives & encodings

| Thing | Encoding |
|-------|----------|
| Hash | SHA-256, lowercase hex (64 chars) for content/chain; raw bytes inside RFC 3161 |
| Public key | base64 of **DER SPKI** (`SubjectPublicKeyInfo`) |
| Signature (Ed25519) | base64 of the raw 64-byte Ed25519 signature |
| Signature (ECDSA P-256) | base64 of the **DER**-encoded ECDSA signature, over SHA-256 of the message |
| keyId | `"<keyName>#v<n>"`, e.g. `fixture:ecdsa-p256#v1` ([`provider.ts:54`](../../packages/core/src/signing/provider.ts)) |

Signature algorithm is chosen **from the keyset entry's `algorithm`**, never from the record —
see §9 for why this matters.

---

## 3. Canonical JSON (the serialization everything hashes)

Reference: [`canonical.ts:16`](../../packages/core/src/chain/canonical.ts). The rules, in full:

- **Objects:** keys sorted lexicographically by **UTF-16 code unit** (JavaScript `Array#sort`
  default); serialized as `{"k1":v1,"k2":v2}` with **no whitespace**.
- **Keys with `undefined` values are dropped** (JSON has no `undefined`).
- **Arrays** preserve order; an `undefined` element becomes `null`.
- **Strings, numbers, booleans:** exactly `JSON.stringify(value)`. Numbers must be **finite**
  (canonicalization throws on `NaN`/`±Infinity`).
- **`null`** → `null`.

```
sha256Hex(value) = SHA-256( utf8( canonicalize(value) ) )   → lowercase hex
```

This is deliberately trivial to re-implement in any language. A Python equivalent:

```python
import json, hashlib
def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
def sha256hex(v):
    return hashlib.sha256(canonical(v).encode()).hexdigest()
```

> Note: Python's `json.dumps(sort_keys=True)` sorts by Unicode code point, which matches the
> UTF-16 order used here for the BMP characters present in these records. For full fidelity on
> astral-plane keys, sort by UTF-16 code unit.

---

## 4. Record content hash

Each record has `content` (the governed action + verdict) and a `seal`. The seal commits to the
content:

```
record.seal.contentHash == sha256Hex(record.content)
```

Reference: [`verify.ts:100`](../../packages/core/src/chain/verify.ts). The `seal` object is
**outside** `content`, so it does not hash itself — it can carry the signature without a circular
dependency.

---

## 5. Seal signature — v1 vs v2

The signature covers the record's **chain position**, not just its content. Reference:
[`provider.ts:67-102`](../../packages/core/src/signing/provider.ts).

- **v1 (legacy)** signed only the content hash — bytes = `utf8(contentHash)`. A v1-signed record
  could be spliced into a different position/tenant by rewriting the (unsigned) `prevHash`.
- **v2 (current; `seal.sigVersion === 2`)** signs a **domain-separated** message binding
  `{sequence, prevHash, contentHash}`:

```
signingMessageV2 = utf8(
  "pharos:record-seal:v2\n" +
  sequence      + "\n" +
  prevHash      + "\n" +
  contentHash
)
```

(That is the literal string: a fixed prefix line, then the decimal sequence, the 64-hex prevHash,
and the 64-hex contentHash, joined by single `\n` newlines.) Verification dispatches on
`sigVersion` ([`provider.ts:94`](../../packages/core/src/signing/provider.ts)); all fixtures here
are v2.

Verify `base64decode(seal.signature)` over these bytes with the public key for `seal.keyId`:
Ed25519 directly, or ECDSA-P256 as `verify(SHA-256, message, sig_DER)`
([`verify.ts:12`](../../packages/core/src/chain/verify.ts)).

---

## 6. Chain verification algorithm

Reference: [`verify.ts:137`](../../packages/core/src/chain/verify.ts). For records in `sequence`
order from 0, maintain `expectedPrev = GENESIS` where `GENESIS` is 64 zeros
([`actionRecord.ts:187`](../../packages/core/src/schema/actionRecord.ts)):

1. **Sequence** increments by exactly 1, no gaps; all records share one `tenantId`.
2. **Content hash** — §4 holds.
3. **Signature** — §5 holds against the keyset entry for `seal.keyId`.
4. **Chain link** — `seal.prevHash == expectedPrev`; then set `expectedPrev = seal.contentHash`.

If every record passes, the chain is intact genesis-to-head: nothing was altered, inserted,
removed, or reordered after sealing. Because signatures are asymmetric, only the KMS private-key
holder could have produced them, and that key never leaves the KMS
([`awsKms.ts:20`](../../packages/core/src/signing/awsKms.ts)).

---

## 7. Keyset publication

The keyset maps `keyId → { publicKey (base64 DER SPKI), algorithm }` and is **append-only**: keys
are rotated by adding a new version; old public keys are never removed, so historical records keep
verifying ([`awsKms.ts:210`](../../packages/core/src/signing/awsKms.ts), and the rotation model in
[THREAT_MODEL.md §8](./THREAT_MODEL.md#8-key-rotation--compromise-model)). A verifier pins the
keyset out of band. A mixed-algorithm chain (Ed25519 history + ECDSA new records) verifies against
the merged keyset — proven in
[`integration.key-migration.test.ts`](../../test/integration.key-migration.test.ts).

---

## 8. Selective-disclosure redaction

Reference: [`redaction.ts`](../../packages/core/src/redaction.ts). Redaction reveals some payload
fields and hides others **without breaking verification**, via per-field commitments:

```
salt[field]        = random  (revealed only for shown fields)
commitment[field]  = sha256Hex( salt[field] + "|" + canonical(value[field]) )
disclosureRoot     = sha256Hex( sorted [ [field, commitment[field]], ... ] )
```

The `disclosureRoot` is **bound to the record** and signed:
`disclosureBindingMessage = utf8( sha256Hex({ disclosureRoot, contentHash }) )`
([`redaction.ts:48`](../../packages/core/src/redaction.ts)). To verify a redacted view: recompute
each **shown** field's commitment from its `(salt, value)`, take the hidden fields' commitments as
given, recompute `disclosureRoot`, and check the binding signature. A redacted view therefore still
proves it came from the sealed original, while hidden values stay hidden. This is **additive** — it
does not change the record's `contentHash` or the chain, so the unredacted original remains intact
and fully verifiable.

---

## 9. RFC 3161 trusted-time anchoring

Reference: [`rfc3161.ts`](../../packages/evidence/src/rfc3161.ts). An anchor over a chain head is a
real RFC 3161 `TimeStampToken` (CMS `SignedData` wrapping `TSTInfo`) stored as base64 DER. It
**verifies fully offline** because the token carries the TSA's signing certificate. Two checks
establish trusted time for a head hash `H`:

1. **The token is for us:** the token's `messageImprint` equals `SHA-256(H)`.
2. **The time is the TSA's:** the CMS signature verifies against the token's **embedded TSA
   certificate**, over the DER of the signed attributes (with the implicit `[0]` tag replaced by
   the universal `SET OF` tag `0x31`, per CMS); the `messageDigest` signed attribute equals the
   hash of the encapsulated `TSTInfo`.

On success the token yields `genTime` — the authority's asserted time. Combined with the chain
(§6), this proves *"these records existed no later than `genTime`"* without trusting Pharos.
Optionally, requiring the TSA cert to chain to a trusted root is a stronger check; the core proof
is (1) + (2).

---

## 10. Hand-verification recipe (target: ≤ 1 day)

Do this against [`bundle-ecdsa-p256-rfc3161-anchored.json`](../../test/fixtures/bundle-ecdsa-p256-rfc3161-anchored.json)
— it exercises content hash, ECDSA signature, chain link, and a real RFC 3161 token. Pure Python
(stdlib + [`cryptography`](https://pypi.org/project/cryptography/)); no repo code.

```python
import json, hashlib, base64
from cryptography.hazmat.primitives.serialization import load_der_public_key
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.exceptions import InvalidSignature

b = json.load(open("test/fixtures/bundle-ecdsa-p256-rfc3161-anchored.json"))
entry = {k["keyId"]: k for k in b["keyset"]}

def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
def sha256hex(v):
    return hashlib.sha256(canonical(v).encode()).hexdigest()

prev = "0" * 64
for r in b["records"]:                       # already in sequence order
    seal = r["seal"]
    assert sha256hex(r["content"]) == seal["contentHash"], "content hash"       # §4
    assert seal["prevHash"] == prev, "chain link"                               # §6
    msg = f'pharos:record-seal:v2\n{r["content"]["sequence"]}\n{seal["prevHash"]}\n{seal["contentHash"]}'.encode()
    k = entry[seal["keyId"]]
    pub = load_der_public_key(base64.b64decode(k["publicKey"]))
    sig = base64.b64decode(seal["signature"])
    assert k["algorithm"] == "ecdsa-p256"
    pub.verify(sig, msg, ec.ECDSA(hashes.SHA256()))                             # §5 (raises on failure)
    prev = seal["contentHash"]
print("chain OK; head =", prev)

# RFC 3161 anchor over the head (§9): messageImprint == sha256(head). Full CMS-signature
# verification is a page of asn1crypto; the messageImprint check alone ties the token to this head.
anchor = b["anchors"][0]
assert anchor["hash"] == prev
tok = base64.b64decode(anchor["token"])
assert hashlib.sha256(prev.encode()).digest() in tok, "messageImprint binds the head"
print("anchor stamps head at", anchor["time"])
```

For the **full** CMS-signature verification of the token (step 2 of §9), the reference is 40 lines:
[`verifyRfc3161Token`](../../packages/evidence/src/rfc3161.ts). To confirm against the reference
implementation with no hand-coding:

```bash
pnpm exec tsx scripts/external-verify.ts --bundle test/fixtures/bundle-ecdsa-p256-rfc3161-anchored.json
# → "Chain verification: PASS - admissible"
# → "Anchor verification: PASS - head existed before the stamped time"
```

Repeat the record loop against `bundle-ed25519.json` (swap the verify call for Ed25519:
`pub.verify(sig, msg)`), and verify the standalone token in `rfc3161-token.json` against its
`anchoredValue`.

---

## 11. Known deviation to be aware of (issue [#67](https://github.com/Bobcatsfan33/Pharos/issues/67))

Every record's `seal.algorithm` field reads `"ed25519"` **even in the ECDSA P-256 bundles**. This
is a known misstatement: `sealRecord` hardcodes the field and the v1 schema locks it
([`seal.ts:36`](../../packages/core/src/chain/seal.ts)). **Do not use `seal.algorithm` for
verification** — the reference verifier does not; it dispatches on the keyset entry's `algorithm`
(§2, §5). This is analyzed in [THREAT_MODEL.md §9](./THREAT_MODEL.md#9-focus-sealalgorithm-misstatement-issue-67)
and fixed via the schema-version machinery. It does not affect the correctness of any signature.

---

## 12. Scope & non-goals

- **In scope:** canonicalization, content hashing, seal signatures (v1/v2), chain verification,
  keyset publication & rotation, selective-disclosure redaction, RFC 3161 anchoring — all offline.
- **Out of scope here:** transport security (TLS/mTLS), authn/authz, tenant isolation, rate
  limiting — those are in [THREAT_MODEL.md](./THREAT_MODEL.md) and
  [pentest-tenant-isolation.md](./pentest-tenant-isolation.md).
- **Not claimed:** this internal package is the input to a **commissioned external cryptographic
  review**, not a substitute for it.

Questions or a finding? Open an issue and tag it `security` / `phase-1`, or annotate the relevant
`file:line` directly.
