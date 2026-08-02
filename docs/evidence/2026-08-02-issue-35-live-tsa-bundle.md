# Issue #35 (S4-T1) — live RFC 3161 TSA + offline bundle verification: run transcript

**Date:** 2026-08-02
**Repo state:** `main` @ `05d79bf3ea2b01ad86118e6a2f88e0bdf259d667`, equal to `origin/main`, clean tree.
**Purpose:** execute the two AC clauses left unverified by the P10 reconciliation comment — an
anchor created against a live TSA, and `scripts/external-verify.ts --bundle` validating a bundle
carrying a **real** RFC 3161 token.

**TSA:** Sectigo, `https://timestamp.sectigo.com`.
**Approved leaf pin (independently obtained):**
`d14751ba71cd8883e560166406cf62cd229a5fe91e308d301976feb23ea90156`

No credentials or key material appear in this file.

---

## 0. Trust material

The pin fingerprints the token's signer leaf:

```
$ openssl x509 -in leaf.pem -noout -subject -issuer -serial
subject= /C=GB/ST=Greater London/O=Sectigo Limited/CN=Sectigo Public Time Stamping Signer R37
issuer=  /C=GB/O=Sectigo Limited/CN=Sectigo Public Time Stamping CA R41
serial=E74EF255B0504FFADBA6DFF7FC8BA315

$ openssl x509 -in leaf.pem -outform DER | shasum -a 256
d14751ba71cd8883e560166406cf62cd229a5fe91e308d301976feb23ea90156
```

Matches `PHAROS_TSA_CERT_SHA256` exactly.

## 1. AC clause — anchor created against a live TSA (network-marked suite)

`test/live-tsa.spec.ts` is collected only by `vitest.live.config.ts` (`test/**/*.spec.ts`), so CI
stays hermetic. Run against Sectigo rather than the FreeTSA default:

```
$ PHAROS_TSA_URL=https://timestamp.sectigo.com \
  PHAROS_TSA_CERT_SHA256=d14751ba…90156 \
  npx vitest run --config vitest.live.config.ts test/live-tsa.spec.ts

 ✓ test/live-tsa.spec.ts (1 test) 529ms
   ✓ live RFC 3161 TSA (network) > requests a real timestamp and verifies it offline  529ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

**PASS.** A real `TimeStampReq` was issued to Sectigo, the returned token verified offline, and
the negative case in that test (a different anchored value) correctly failed to verify.

## 2. Bundle carrying a real token

An evidence bundle was produced with `PHAROS_TSA_PROVIDER=rfc3161` pointed at Sectigo, on its own
tenant (`tsa-live-evidence`) so no existing chain was touched:

```
TSA provider in effect: rfc3161
Provisioned tenant "tsa-live-evidence" (key tenant:tsa-live-evidence).
  seq 0  email.send     -> allow
  seq 1  crm.update     -> allow
Anchored head: seq 1 16e80118858f1050…
Anchors: rfc3161(token)
Bundle written (2 records, 1 anchors).
```

Bundle anchor identity:

| Field | Value |
|---|---|
| provider | `rfc3161` |
| TSA `genTime` | `2026-08-02T15:33:34.000Z` |
| anchored head hash | `16e80118858f105015ea4218d7eaa82352cec6e0310e9b71efd4b1689ed5004c` |
| token DER size | 6632 bytes |
| token SHA-256 | `2ab480536d61f40f161c269bceeab505531ea2dc655e8a1341fea79aa699d8de` |

## 3. AC clause — `external-verify --bundle` validates it, no Pharos infra

```
$ npx tsx scripts/external-verify.ts --bundle <bundle>.json \
    --tsa-cert-sha256 d14751ba…90156

=== Offline evidence bundle verification for tenant "tsa-live-evidence" ===
Verifying 2 records with @pharos/core ONLY (no DB, no signer, no platform calls)...

  OK  seq   0  hash:ok sig:ok link:ok
  OK  seq   1  hash:ok sig:ok link:ok

Chain verification: PASS - admissible

Trusted-time anchors (1):
  OK  anchor [rfc3161] 16e80118858f… @ 2026-08-02T15:33:34.000Z  (head)

Anchor verification: PASS - head existed before the stamped time
(exit 0)
```

**PASS.**

### Negative controls (so the PASS above means something)

| Case | Expected | Observed | Exit |
|---|---|---|---|
| Correct pin | accept | `OK anchor [rfc3161]` … `PASS` | `0` |
| Wrong pin (all zeros) | reject | `BAD anchor [rfc3161]`, `BAD no valid anchor covers the head record`, `Anchor verification: FAIL` | `1` |
| No pin supplied | refuse to verify | throws: *"RFC 3161 verification requires `--tsa-cert-sha256` from an independent approved source"* | `1` |

The pin is genuinely load-bearing: the verifier neither accepts an unapproved signer nor lets an
`rfc3161` anchor pass on the token's self-asserted trust.

---

## 4. Note on the ESS / `ts -verify` tool failures

The `openssl ts -verify` failures seen while qualifying this endpoint do **not** arise in the
Pharos verification path, and no endpoint change was needed.

`verifyRfc3161Token` (`packages/evidence/src/rfc3161.ts`) never parses the ESS
`SigningCertificate` attribute or its `issuerSerial` field. It identifies the signer by trial
CMS signature verification across the certificates embedded in the token
(`rfc3161.ts:213-225`), then applies the enterprise trust boundary as a SHA-256 fingerprint pin
on that signer (`rfc3161.ts:244-253`). The v1 `ESSCertID` `issuerSerial` comparison that LibreSSL
and OpenSSL each stumbled over is simply never exercised, so a token that is internally
consistent — as this one was independently shown to be — verifies cleanly.

Recorded as a property of the implementation, not a workaround: the pin is a *stronger* signer
binding than the ESS attribute for this purpose, since it is supplied out of band rather than
read from the token. Worth noting explicitly for procurement review, the verifier states its own
limit at `rfc3161.ts:255-257` — it "deliberately does not claim general PKIX path building;
approved signer pins are the production trust boundary." Trust here rests on the pin, not on
chain construction to a root.

## 5. Result

Both remaining #35 AC clauses pass on live evidence. No code change was required.
