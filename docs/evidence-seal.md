# Evidence that stands up outside Pharos (Sprint 5 — Seal)

Sprint 5 upgrades evidence from cryptographically neat to legally usable: trusted
timestamps, external anchoring, field-level redaction, litigation hold, claims-pack
assembly, regulatory exports, and the scoped exchange portal.

## Trusted time & anchoring

Chain heads are timestamped and signed by an **independent** timestamp authority (a separate
keystore standing in for an RFC 3161 TSA + external transparency log;
[`timestamp.ts`](../packages/evidence/src/timestamp.ts)). Anchors are stored in
`chain_anchors` and embedded in claims packs. Because the TSA key is not the platform key,
tamper-evidence does not require trusting Pharos.

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
