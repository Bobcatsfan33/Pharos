# Demo — an agent tries to move money

One story, four acts, about a minute. An agent attempts a funds transfer it has no
authority to make; Pharos refuses and cites the rule. A treasury controller grants a
mandate; the identical transfer now passes. Both decisions are sealed into an evidence
chain that a third party verifies **offline**, with no Pharos infrastructure and no trust
in us.

Everything here is **hermetic and free** — local KMS signing and the local timestamp
authority. Nothing leaves your machine, no cloud account, no paid TSA. Production swaps in
AWS KMS and a real RFC 3161 authority through the same interfaces; see
[LIMITATIONS.md](LIMITATIONS.md) for what that promotion still needs.

## Run it

```bash
pnpm install
cp .env.example .env
pnpm infra:up      # Postgres + Redis + MinIO
pnpm demo
```

```

═══ Pharos demo — an agent tries to move money ═══
Signing: local KMS.  Trusted time: local TSA.  Nothing leaves this machine.

── Act 1 ─ the agent acts without authority

  treasury-bot wants to wire $4,800 to new-vendor-8812.
  It holds no mandate for moving funds.

  Verdict:   ESCALATE   tier 3
  Cited:     finra-3110-funds-movement  FINRA Rule 3110 (supervision) / 2150 (funds handling)
             Movement of customer funds requires supervisory review. Unmandated funds-movement intent is escalated to a registered principal under Rule 3110 supervision.

  Sealed as evidence anyway — a refusal is a fact worth proving.
  record #0  hash 9f34ad8b0e6293ca…

── Act 2 ─ treasury grants a mandate

  treasury-controller grants m-vendor-payments — vendor payments up to $25,000.
  The mandate is stored server-side. A caller cannot assert one it was not granted.

  Same transfer. Same agent. Same amount.

  Verdict:   ALLOW   tier 3

  record #1  hash 8880a43f2d335e54…

── Act 3 ─ the evidence anchors in trusted time

  Chain head sequence 1 anchored.
  The anchor proves the head existed before the stamped time —
  signed by an independent authority, not by Pharos's own keys.

── Act 4 ─ the bundle a third party can check without us

  Wrote evidence-bundle.json — 2 records, the public
  keyset, and the trusted-time anchor. No secrets: only public keys.

  This file is the whole evidence package. Hand it to an auditor,
  a regulator, or opposing counsel — they need nothing else.

═══ Two decisions, both provable ═══
  Verify the bundle yourself, offline, trusting nothing:

      pnpm verify:bundle evidence-bundle.json
```

Then, in the same terminal — the verifier needs no server running:

```bash
pnpm verify:bundle evidence-bundle.json
```

```
=== Offline evidence bundle verification for tenant "acme-treasury" ===
Verifying 2 records with @pharos/core ONLY (no DB, no signer, no platform calls)...

  OK  seq   0  hash:ok sig:ok link:ok
  OK  seq   1  hash:ok sig:ok link:ok

Chain verification: PASS - admissible

Trusted-time anchors (1):
  OK  anchor [local] 8880a43f2d33… @ 2026-08-02T20:53:45.971Z  (head)

Anchor verification: PASS - head existed before the stamped time
```

## What just happened

**Act 1 — the refusal is evidence too.** The unmandated transfer reached Tier 3 and was
escalated, citing `finra-3110-funds-movement` with an examiner-readable explanation. Note
that the refusal was **sealed into the chain**: a system that only records what it allowed
cannot answer "what did you stop, and why?".

**Act 2 — authority is server-side.** The mandate is created by the treasury controller and
stored; the agent references it by id. A caller **cannot assert a mandate it was not
granted** — the API refuses an inline `liability.mandate` outright
([#81](https://github.com/Bobcatsfan33/Pharos/issues/81)), because the cascade stands
mandate-gated controls down when one is present. Same transfer, same amount, same agent —
only the authority differs, and the verdict flips.

**Act 3 — trusted time.** The chain head is anchored by an authority holding **independent
keys**, so the anchor is not something Pharos can forge with its own signing key. It proves
the head existed *before* the stamped time.

**Act 4 — the bundle.** `evidence-bundle.json` is the whole package: the records, the
public keyset, and the anchor. **No secrets** — public keys only. Hand it to an auditor, a
regulator, or opposing counsel.

The verifier then re-derives every hash, checks every signature against the published
keyset, walks the chain link by link, and checks the anchor — using `@pharos/core` **only**:
no database, no signer, no platform calls. That is what `PASS - admissible` means.

## What this demo does not show

Honesty matters more than a clean demo, so:

- **The Tier-3 judge here is a linear bag-of-words classifier**, not a transformer. It is
  the honest default path and it is **defeated by paraphrase**. The transformer judges are
  wired and served but remain restricted pre-production — see the
  [model cards](model-cards/production-judges.md). No judge is promoted.
- **The timestamp authority is `local`** — a simulated TSA with independent keys, which is
  what makes the demo free and hermetic. A real RFC 3161 run against a public authority,
  with the certificate pin verified, is recorded in
  [evidence/2026-08-02-issue-35-live-tsa-bundle.md](evidence/2026-08-02-issue-35-live-tsa-bundle.md).
- **Signing is local Ed25519**, not AWS KMS. The live AWS KMS durability run is in
  [evidence/2026-08-02-issue-34-aws-kms-durability.md](evidence/2026-08-02-issue-34-aws-kms-durability.md).
- The escalation is shown reaching a verdict; the full **review workflow** (queue routing,
  SLA, human resolution, resume) is exercised in the integration suite rather than here.

## Try breaking it

The demo is more convincing if you attack it. Open `evidence-bundle.json` and change one
character inside any record's `content` — a digit in the amount, a letter in the memo —
then re-run:

```bash
pnpm verify:bundle evidence-bundle.json
```

Executed against a bundle whose first record had its `amount` changed from `4800` to `9999`:

```
  BAD seq   0  hash:BAD sig:ok link:ok
  OK  seq   1  hash:ok sig:ok link:ok

Chain verification: FAIL
```

Look closely at *which* check failed, because it is the interesting part. `sig:ok` — the
signature still verifies, because it was computed over the **sealed** `contentHash`, and
that value is still sitting in the seal. `link:ok` — the next record still points at that
same sealed hash. What breaks is `hash:BAD`: the verifier **recomputed** SHA-256 over the
record's content and got a different answer than the seal claims.

That is the whole trick. An attacker who edits content must also forge a matching
`contentHash`, and then a signature over it — and the signing key never left the keystore
and is not in the bundle. Editing the seal's hash instead just moves the failure to
`sig:BAD`.

## Next

- [Offline verification in depth](external-verification.md) — the procedure a third party follows
- [Decision cascade](decision-cascade.md) — how the tiers reach a verdict
- [Evidence & sealing](evidence-seal.md) — chain, anchoring, redaction, claims packs
