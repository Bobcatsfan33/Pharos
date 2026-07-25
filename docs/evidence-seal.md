# Evidence that stands up outside Pharos (Sprint 5 — Seal)

Sprint 5 upgrades evidence from cryptographically neat to legally usable: trusted
timestamps, external anchoring, field-level redaction, litigation hold, claims-pack
assembly, regulatory exports, and the scoped exchange portal.

## Trusted time & anchoring

Chain heads are timestamped by an **independent** trusted-time authority. Two providers are
supported ([`timestamp.ts`](../packages/evidence/src/timestamp.ts)):

- **`rfc3161`** — a real RFC 3161 TSA ([`rfc3161.ts`](../packages/evidence/src/rfc3161.ts)):
  Pharos builds the `TimeStampReq` over `sha256(head)` (ASN.1 via `pkijs`/`asn1js`, not
  hand-rolled), POSTs it to a configurable TSA (`PHAROS_TSA_URL`), and stores the full DER
  `TimeStampToken` verbatim in the anchor. The token carries the TSA's signing certificate, so
  it **verifies fully offline** — `verifyRfc3161Token` checks the CMS signature against the
  embedded cert and that the `messageImprint` equals `sha256(head)`. No third-party token is
  minted by a key Pharos controls, so this carries independent legal weight.
- **`local`** — a separate keystore key stamps the time (hermetic; the dev/test default). The
  TSA key is still not the platform key, so tamper-evidence does not require trusting Pharos,
  but the token is not a third-party RFC 3161 token.

Anchors are stored in `chain_anchors` (provider + DER token) and embedded in claims packs; the
offline verifier (`scripts/external-verify.ts --bundle`) validates them with no Pharos access.

### Scheduling & gap detection

Heads are anchored two ways:

- **On demand** — `POST /v1/tenants/:tenantId/anchor` anchors a tenant's current head; sealing a
  claims pack also anchors the pack's head so the exported bundle carries its own proof.
- **On a schedule** — the [`AnchorScheduler`](../packages/storage/src/anchorScheduler.ts) anchors
  every tenant's head on a fixed interval (default **hourly**, `PHAROS_TSA_ANCHOR_INTERVAL_MS`; set
  `0` to disable). A per-tenant failure is logged and never aborts the sweep.

The chain-integrity sweep cross-checks anchoring: if a tenant's head has advanced past its newest
anchor, if no anchor exists, or if the newest anchor is older than `2×` the schedule interval, it
raises a **non-fatal `chainIntegrity` warning** (it does not flip `ok` — a missing anchor is not a
chain break). The warnings and the anchoring summary (`latestAnchorSequence`, `headAnchored`) are
returned by `GET /v1/chain/:tenantId/verify` and surfaced in the console's **Ledger → Chain
integrity** view.

## Field-level redaction (selective disclosure)

Every record commits to each payload field at seal time
(`commitment = sha256(salt||value)`); the disclosure root is signed and **bound to the
record's contentHash** ([`redaction.ts`](../packages/core/src/redaction.ts)). A redacted
view reveals (salt, value) for shown fields and only the commitment for redacted ones — and
**still verifies cryptographically**. This is additive: it does not change the record's
contentHash or chain, so the unredacted original stays intact and fully verifiable in WORM.

## Litigation hold

Holds ([`evidenceOpsStore.ts`](../packages/storage/src/evidenceOpsStore.ts)) freeze retention
and **disable redaction** on covered record ranges — you cannot redact what is under hold, so
the original is preserved for litigation. The hold itself is logged.

## Claims packs v2

One-click assembly from an incident ([`claimsPack.ts`](../packages/evidence/src/claimsPack.ts)):
a scoped record set + custody attestation + verification bundle (keysets, anchors,
procedure), audience-scoped (claims adjuster / outside counsel / regulator / broker), with
statuses draft → sealed → released. `verifyClaimsPack` validates a bundle **offline**.

## Regulatory exports

FINRA examination, EU AI Act Article 12 record-keeping, and SR 11-7 model-risk documentation
export from live records ([`exports.ts`](../packages/evidence/src/exports.ts)). External
counsel review of each against the requirement text is a Sprint-5 legal gate.

## Exchange portal

Released packs are read through a consent-gated, **access-audited** path; every external read
or share lands in the hash-chained access audit (Sprint 1).

## Legal

[Admissibility white paper](legal/admissibility.md) (FRE 901, 902(13)–(14)) and the
[expert-witness verification runbook](legal/expert-verification-runbook.md). Counsel review is
the remaining external gate.

## Exit-criteria proof

`test/integration.seal.test.ts` runs the full incident drill: declare incident → hold →
assemble pack → seal → release to a scoped counsel account → **offline third-party
verification**; redaction is disabled under hold; a redacted pack verifies cryptographically;
originals stay intact; all three regulatory exports generate; the access audit chain verifies.
