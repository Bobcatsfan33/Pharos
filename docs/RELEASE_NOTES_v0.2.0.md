# Release notes — v0.2.0

---

**Pharos v0.2.0** — real-time policy verdicts for AI agents, with cryptographic evidence of
every decision. *Pharos decides. Pharos proves.*

Where 0.1.x built the platform, **0.2.0 spent its time trying to break it.** A full
threat-model reconciliation turned every accepted risk into either a fix with a regression
test, or a documented decision with a named owner. Several findings were real defects that
only surfaced when a claim was *executed* rather than read.

## What's in it

**Security and correctness**

- **The rate limiter failed open.** It returned `true` from its `catch` block, so anything
  that made the counter store unreachable also removed the ingest rate limit. Now fails
  closed with `503 rate_limiter_unavailable` — deliberately distinct from `429` — plus a
  per-tenant aggregate budget, so minting extra API keys cannot multiply a quota.
- **A caller could forge a mandate.** Supplying an inline `liability.mandate` stood
  mandate-gated controls down: an unmandated transfer went from `escalate` (citing FINRA
  3110) to `allow` with **no citations**, and the invented grant was sealed into evidence
  naming a grantor who never issued it. Authority is now server-derived only.
- **SDK validation at the trust boundary.** A safety fix rather than ergonomics: when the
  platform is unreachable the SDK chooses its local fail-mode from
  `liability.blastRadius.reversibility`, so a misspelled field previously allowed an
  **irreversible** action to fail *open*.
- **WORM verify-on-read.** The copy kept specifically to detect tampering was being read
  without re-deriving its hash. Plus a working `reconcile()` and a fail-closed Object Lock
  assertion at startup.
- **`seal.algorithm` now states the real signing algorithm** (schema **v1.1.0**).
  `aws-kms` records previously claimed `ed25519`. Historical records are **never rewritten**
  and still verify; verification still dispatches on the published keyset, never on the
  self-declared field.
- Constant-time admin-token comparison; optional exactly-once ingest via `idempotencyKey`;
  fault-injection hooks removed from the production cascade; console authentication with
  per-user tenant scoping and a CSP carrying no `'unsafe-*'` token.

**New**

- **`pnpm demo`** — the funds-transfer walkthrough. An agent tries to wire money with no
  mandate and is escalated with the FINRA clause cited; treasury grants a mandate and the
  identical transfer passes; the evidence bundle verifies **offline** with chain `PASS` and
  anchor `PASS`. Hermetic and free — local KMS, local TSA, nothing leaves the machine.
- Live external-gate transcripts against **AWS KMS** and a **real RFC 3161 authority**
  (Sectigo, certificate pin verified) under `docs/evidence/`.

**Changed**

- README rewritten for a first-time visitor, with a quickstart that was executed on a clean
  checkout rather than assumed.
- `@getpharos/sdk` **0.1.1 → 0.2.0**. `getpharos` (Python) **0.2.0**.

## Install

```bash
npm install @getpharos/sdk        # TypeScript
pip install getpharos             # Python
```

> The v0.1.1 release notes said `@getpharos/sdk-ts`. **That package does not exist** — the
> published name is `@getpharos/sdk`. Corrected here.

## Verifying the release artifacts

The container image is built reproducibly, signed with cosign keyless (Sigstore), and ships
an SBOM and SLSA provenance attestation. Verify before you run it:

```bash
IMAGE=ghcr.io/bobcatsfan33/pharos-api
DIGEST=$(crane digest "$IMAGE:v0.2.0")     # or read it from the release asset list

# 1. The image was signed by this repository's release workflow, not by a person.
cosign verify \
  --certificate-identity-regexp "^https://github.com/Bobcatsfan33/Pharos/" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE@$DIGEST"

# 2. Its build provenance attestation.
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp "^https://github.com/Bobcatsfan33/Pharos/" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE@$DIGEST"
```

Always deploy by **digest**, not by tag — the Helm chart takes `image.digest` for exactly
this reason. npm packages are published with **provenance**, so `npm audit signatures`
attests them back to this repository and workflow.

## Status — what is and isn't proven

Unchanged from the README, and deliberately so:

- **Pharos is not production-approved, and its own readiness manifest says so.**
  `docs/enterprise-readiness.json` is machine-checked in CI and reads `decision:
  not-approved` with **6 open blocking gates**. It is published rather than hidden.
- **The Tier-3 judges on the default path are linear bag-of-words classifiers.** They are
  the honest demo path and they are **defeated by paraphrase**. The transformer judges are
  wired and served but remain **restricted pre-production** — their model cards list the
  adversarial-efficacy, calibration, and independent-validation evidence still missing.
  **No judge is promoted in this release.**
- **The p99 3.7 ms / ~5,400 verdicts-per-second figure was measured with the linear
  judges** and is **not** a transformer production claim. The production-topology
  re-benchmark is open.
- Every known gap is enumerated in [`docs/LIMITATIONS.md`](LIMITATIONS.md).

## Full detail

[CHANGELOG.md](../CHANGELOG.md) · [docs/demo.md](demo.md) · [docs/LIMITATIONS.md](LIMITATIONS.md)

---

## Cutting this release (maintainer)

Not done by an agent, because it publishes to public registries irreversibly and
`release.yml` notes the first publish of each package is a maintainer action.

```bash
git checkout main && git pull
git tag -a v0.2.0 -m "Pharos v0.2.0 — the hardening release"
git push origin v0.2.0
gh release create v0.2.0 --title "Pharos v0.2.0" --notes-file docs/RELEASE_NOTES_v0.2.0.md
```

Before pushing the tag, confirm: npm trusted publishing is configured for `@getpharos/sdk`
→ this repo + `release.yml`, and the PyPI trusted publisher for `getpharos` is live
(see [PUBLISHING.md](PUBLISHING.md)). Afterwards, replace `unreleased` with the date in
`CHANGELOG.md`.

**Also worth fixing while you are there:** the published
[v0.1.1 release notes](https://github.com/Bobcatsfan33/Pharos/releases/tag/v0.1.1) tell
readers to `npm install @getpharos/sdk-ts`, which does not exist, and describe a transformer
judge as "rolling onto the served path" — language we no longer use. Both are edits to an
existing release body.
