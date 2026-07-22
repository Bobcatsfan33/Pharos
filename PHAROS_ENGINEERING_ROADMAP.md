# Pharos — Enterprise Engineering Roadmap

**Version 1.1 · July 2026 · Owner: Engineering Lead** *(amended after Sprint 1 — see §7 Amendment log)*
**Audience: the implementation team (junior–mid level developers). Read this whole document before writing any code.**

---

## 0. How to use this document

This roadmap turns the Pharos prototype (github.com/Bobcatsfan33/Pharos) into an enterprise-ready product. It is written so that a junior developer can pick up any task and know: what to build, where in the repo it goes, how to prove it works, and what "done" means.

Assumptions:

- Team of 4 developers plus 1 tech lead. Two-week sprints. Sprints 1–12 (~6 months) get us to pilot-ready; Phase 5 runs external gates (audits, pen test) that are not pure engineering.
- Every task has an ID like `S3-T2` (Sprint 3, Task 2). Use these IDs in branch names (`s3-t2-aws-kms-provider`), PR titles, and commit messages so work is traceable back to this document.
- If a task turns out to be wrong or impossible as written, do not silently improvise. Write up what you found, propose an alternative, and get the tech lead to amend this document. The roadmap is versioned; changes to it are PRs like anything else (see §7 for amendments made so far).

The prime directive for this codebase: **Pharos sells trust. Anything that makes a claim the code cannot back is a bug, even if it's in a README and not in a `.ts` file.** You will see several tasks that are "just docs." They are not optional garnish; they are the product.

---

## 1. Orientation — what you are working on

Pharos is a governance layer for AI agents. Every consequential agent action is sent to Pharos **before it executes**. Pharos returns a verdict — `allow`, `block`, `modify`, or `escalate` (to a human) — decided by a three-tier cascade under a hard latency deadline. The same transaction that produces the verdict also writes a **cryptographically signed, hash-chained evidence record** to write-once (WORM) storage. The verdict governs the action; the record proves how it was governed. That single-transaction invariant is the core of the product. Never break it.

### 1.1 Repo tour

| Path | What it is | Health |
|---|---|---|
| `packages/core` | `ActionRecord` schema v1, canonical hashing, seal/chain verification, signing provider abstraction (`src/signing/provider.ts`), local KMS (`src/signing/localKms.ts`), Tier-1 verdict engine | Solid. The seal-v2 anti-splice signing (`signingMessageV2`) is good work. **Do not modify crypto here without an RFC + tech-lead review.** |
| `packages/storage` | Postgres (operational state + chain heads), S3 Object Lock WORM (`wormStore.ts`), Redis cache, migrations, escalation/policy/tenant/evidence stores | Solid design. Per-tenant chain head serializes appends — a known throughput ceiling addressed in Phase 4. |
| `packages/cascade` | The tiered verdict cascade (`cascade.ts`), deadline manager, risk scorer, replay harness | Structure is good; Tier 3 behind it is the weak point (see judge). |
| `packages/judge` | "Distilled judge models" — **actually bag-of-words unigram/bigram logistic regression** (`src/model.ts`, `src/featurize.ts`) trained on a few dozen hand-written examples in `data/` | The biggest gap in the product. Replaced in Phase 2. The registry/content-hash versioning (`registry.ts`, `modelVersion()`) is good and stays. |
| `packages/policy` | Rule DSL (`rules.ts`), constrained-grammar policy compiler v1 (~5 patterns, `compiler.ts`), FINRA/HIPAA packs, dry-run simulator | Lifecycle (compile → dry-run → shadow → active → rollback) is good. Interop in Phase 3. |
| `packages/identity` | OIDC verification (jose), API keys, deny-by-default RBAC | Good bones. |
| `packages/evidence` | Timestamp "anchoring" (`timestamp.ts` — **a simulated TSA, not real RFC 3161**), claims packs, exports | Real TSA in Phase 1. |
| `packages/assurance`, `review`, `billing`, `observability`, `middleware`, `pdp-spec`, `config` | Assurance sampling/Wilson bound, review queues/SLA, metering, Prometheus/tracing, framework adapters + conformance, open PDP spec, Zod config | Reasonable for their stage. |
| `services/api` | Fastify ingestion API, composition root (`platform.ts`), routes | Fine. |
| `services/gateway` | Zero-code HTTP egress proxy | **Holds escalated requests in an in-memory `Map`** (`gateway.ts`) and strips almost all headers when forwarding. Hardened in Phase 3. Note: server-side escalations (`packages/storage/src/escalationStore.ts`) ARE durable in Postgres — it's only the gateway's held request bodies that evaporate on restart. |
| `sdks/python`, `packages/sdk-ts` | Python + TS SDKs (`pharos-sdk`, `@pharos/sdk`) with a shared conformance contract | Good; unpublished (Sprint 2). |
| `apps/console` | Next.js console | Thin; not a roadmap focus until Phase 5. |
| `test/` (157 TS tests at v0.1.0 — treat counts as floors, not fixed numbers), `sdks/python/tests` (10) | Unit + integration against real Postgres/Redis/MinIO | The CI gate in `.github/workflows/ci.yml` **fails the build if integration tests skip**. Never weaken this. |
| `deploy/` | Compose (prod), Helm chart, INSTALL.md | Honest about the KMS placeholder until S3-T1 lands. |

### 1.2 Running it locally

```bash
pnpm install
pnpm infra:up          # Postgres + Redis + MinIO via docker compose
cp .env.example .env
pnpm test              # the full suite (157 TS at v0.1.0, 0 skips) must pass before you start ANY task
pnpm api:dev           # API on :4000
```

See `docs/ONBOARDING.md` (added in S1-T6) for the verified clean-machine transcript, including the two-terminal `api:dev` + `verify:external` sequence.

If `pnpm test` is not fully green on your machine on day one, stop and fix your environment with the tech lead before doing anything else.

### 1.3 Glossary

- **ActionRecord** — the single event carrying both verdict context and liability context; signed once, chained once. Schema v1 is frozen (`packages/core/src/schema/actionRecord.ts`).
- **Cascade / Tiers** — Tier 1 deterministic rules → Tier 2 statistical risk score → Tier 3 semantic judge models. Short-circuits on deterministic block or extreme risk.
- **Fail-open / fail-closed** — on deadline breach or judge fault: reversible actions are allowed and queued for async review (fail-open); irreversible actions escalate to a human (fail-closed). See `cascade.ts#failMode`.
- **WORM** — S3 Object Lock, COMPLIANCE mode; sealed records can't be altered before retention expires.
- **Seal v2** — signature binds `{sequence, prevHash, contentHash}` so a record can't be spliced into another chain position.
- **PDP** — policy decision point; the open spec lives in `docs/spec/pdp-v1.md` with a conformance suite in `packages/pdp-spec`.
- **Mandate** — a pre-authorized scope for an agent (e.g. "$25k limit"); Tier-1 enforces it.

---

## 2. Ground rules (every sprint, every task)

1. **Green before and after.** `pnpm -r typecheck && pnpm test` green before you branch and before you open a PR. CI must stay on the "integration tests must run, not skip" gate.
2. **One task, one PR.** Branch `s<sprint>-t<task>-short-name`. PR description links the task ID and quotes its acceptance criteria with checkboxes.
3. **No crypto invention.** You may *call* crypto (KMS SDKs, `jose`, `node:crypto`); you may not *design* crypto (new signing schemes, new canonicalization, new chain formats) without an RFC approved by the tech lead.
4. **The frozen schema stays frozen.** `ActionRecord` v1 doesn't change. New fields go through the schema-version machinery (`packages/core/src/schema/version.ts`) with migration adapters, behind an RFC.
5. **Every behavior claim gets a test.** If a doc says "restart-safe," there is a test that restarts the thing.
6. **Honest docs.** When you complete a task, update any doc your change makes false. Overclaiming in docs is a P1 bug in this product. When doing a truth pass, always re-read summary/"remaining work" statements too — a summary can contradict a corrected detail (this bit us once; see §7, amendment 4).
7. **Secrets never in the repo.** `.env` files are local; CI uses GitHub secrets; anything that looks like a credential in a PR fails review.
8. **Ask early.** Thirty minutes stuck → write down what you tried → ask in the team channel. Two hours stuck silently is the only way to actually fail here.

Definition of Done (all tasks): acceptance criteria met · tests added/updated and green · typecheck green · docs updated · PR reviewed by one peer + tech lead for anything touching `core`, `storage`, or `identity` · task ID in the merge commit.

Note on CODEOWNERS: `.github/CODEOWNERS` routes `core`/`storage`/`identity` to the tech lead, but GitHub *required-review* branch protection stays **off** until the repo has a second maintainer — with a single owner it would deadlock all merges. Review is enforced by process (this section), not by the platform, for now.

---

## 3. Roadmap at a glance

| Phase | Sprints | Theme | Exit criterion (demoable) |
|---|---|---|---|
| 0 | 1–2 | Open-source & release foundation | A stranger can legally use, build, verify, and install Pharos from signed, versioned artifacts; README claims match code |
| 1 | 3–4 | Trust core: real KMS + real timestamps | Evidence signed by AWS KMS; chain heads anchored to a real RFC 3161 TSA; threat model published |
| 2 | 5–7 | Real Tier-3 judges + adversarial evals | Transformer judges served on CPU behind the existing interface; public eval report incl. adversarial suites; honest latency benchmark |
| 3 | 8–9 | Integration surface | Gateway is restart-safe and header-correct; MCP middleware ships; Cedar policy interop; OTel/OCSF export |
| 4 | 10–11 | Scale & reliability | Published contention/backpressure numbers; dependency-degradation matrix tested; failover exercise runs on a schedule in CI |
| 5 | 12+ | External attestation & pilot | Pen-test + SOC 2 evidence tooling ready; design-partner onboarding kit; external gates tracked |

Dependencies: Phase 1 blocks nothing else (parallel-safe). Phase 2 Sprint 5 (evals) **must** land before Sprint 6 (models) — we refuse to ship models we can't measure. Phase 3 gateway work is independent of Phase 2. Phase 4 needs Phases 1–3 merged.

---

## PHASE 0 — Foundation (Sprints 1–2)

Nothing in this phase is algorithmically hard. All of it is what makes the difference between "a repo" and "a product an enterprise is allowed to evaluate." *Historical note: the gaps listed below were the verified state before Sprint 1 (no LICENSE, no SECURITY.md, no CONTRIBUTING.md, no eslint config despite a `lint` script, nothing published to npm/PyPI, no releases, no SBOM, an overclaiming README). Sprint 1 closed the repo-hygiene and honesty items on 2026-07-21; Sprint 2 covers the publishing items.*

### Sprint 1 — "Make it real open source, and make the words true" ✅ COMPLETE (2026-07-21)

**Delivered via PRs #4, #5, #6, #7, #19, #21, #22; tag `v0.1.0` + release published. Final report accepted by the tech lead; amendments recorded in §7.** The task specs below are kept for the record.

**Sprint goal:** the repo becomes legally usable, contributable, and honest. Zero product-behavior changes.

**S1-T1 · License and legal scaffolding.** *(done — PR #4)*
Add `LICENSE` (Apache-2.0, exact standard text) and `NOTICE`. SPDX per-file headers NOT required (skip; noise). Add a `license` field to every `package.json` (root, all `packages/*`, `services/*`, `apps/*`) and Apache-2.0 in `sdks/python/pyproject.toml`.
*AC:* `ls LICENSE NOTICE` succeeds; `grep -L '"license"' packages/*/package.json services/*/package.json` returns nothing; GitHub UI shows "Apache-2.0" on the repo page.

**S1-T2 · Community and security files.** *(done — PR #5)*
Add `SECURITY.md` (private disclosure via GitHub security advisories; 90-day disclosure window; supported-versions table), `CONTRIBUTING.md` (dev setup = §1.2, PR rules = §2, DCO sign-off — `git commit -s`), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `.github/CODEOWNERS`, `.github/pull_request_template.md`, issue templates (bug / feature / security-redirect), DCO CI check.
*AC:* all files exist; opening a PR shows the template; a commit without `Signed-off-by` fails the DCO check.

**S1-T3 · README/docs truth pass.** *(done — PRs #6 + #22)*
The six corrections (judges → linear bag-of-words classifiers, "zero regex" removed; benchmark caveated pending S7-T1; KMS → local-only today, AWS = S3-T1; TSA → simulated, RFC 3161 = S4-T1; compiler → constrained-grammar v1; `docs/LIMITATIONS.md` created and linked from Status), **plus item 7 added by amendment: reconcile the Status section's "remaining work" summary so it doesn't contradict LIMITATIONS.md** (caught on final read; fixed in #22).
*AC:* a reviewer can't find a README claim contradicted by the code; `docs/LIMITATIONS.md` lists ≥ the five items above plus the gateway in-memory held-request limitation.

**S1-T4 · Make lint real; CI hardening.** *(done — PR #7; prettier resolution in §7, amendment 2 → task S2-T6)*
ESLint 9 flat config + `typescript-eslint` recommended (not stylistic), prettier check, lint job in CI, `pnpm audit` report step, Dependabot config for npm + pip + actions.
*AC:* `pnpm lint` passes locally and in CI; CI has jobs: lint, typecheck+test, python-sdk; `.github/dependabot.yml` exists.

**S1-T5 · Versioning and changelog machinery.** *(done — PR #19)*
Changesets across the workspace; changeset-required CI gate with `no-changeset` label escape; `CHANGELOG.md` seeded at 0.1.0; tag `v0.1.0` with release notes.
*AC:* `pnpm changeset version` bumps correctly; CI fails an un-changeset'd publishable-package PR; tag exists.

**S1-T6 · Clean-machine onboarding proof.** *(done — PR #21)*
Fresh-clone quickstart run; fixed the `verify:external` two-terminal gap; `docs/ONBOARDING.md` with real transcripts.
*AC:* a second team member reproduces the transcript start-to-finish in under 30 minutes without asking anyone anything.

### Sprint 2 — "Artifacts someone can consume"

**Sprint goal:** Pharos is installable from published, signed artifacts, not from a git clone.

**Day-1 human dependencies (tech lead, flag at sprint planning):** npm org + PyPI trusted-publisher credentials as repo secrets (blocks S2-T1); name-availability check for `@pharos/sdk` / `pharos-sdk`.

**S2-T0 · Dependabot triage policy + first sweep.** *(added by amendment — see §7, amendment 5)*
Dependabot went live mid-Sprint-1 and immediately opened 12 PRs (#8–#18, #20), several of them **majors** (zod 3→4, jose 5→6, Next 15→16, @fastify/cors 10→11, GitHub Actions majors). Do not blind-merge majors. Write the policy into `CONTRIBUTING.md`: patch/minor dev-deps → merge when CI is green; runtime-dep minors → merge with a skim of the changelog; **majors → one PR at a time, read the migration notes, full suite green, and a human decision** (zod 4 and jose 6 touch validation and token verification — the trust path; Next 16 touches only the out-of-scope console). Tune `dependabot.yml` grouping (group actions majors; group dev-deps, already partly done) to cut PR noise. Then execute the first sweep.
*AC:* policy merged in CONTRIBUTING.md; every currently-open Dependabot PR is merged or closed-with-reason; open Dependabot PR count is 0 at sprint end; `dependabot.yml` grouping updated.

**S2-T1 · Publish the SDKs.**
Publish `@pharos/sdk` to npm and `pharos-sdk` to PyPI (⚠ check name availability day 1; if taken, decide fallback names with the tech lead immediately). `release.yml` workflow: on version tag → build, test, publish with provenance (`npm publish --provenance`, PyPI trusted publishing/OIDC).
*AC:* `npm install @pharos/sdk` and `pip install pharos-sdk` work from a clean machine; both packages show provenance/trusted-publisher badges; `examples/langgraph-agent.ts` runs against the published package.

**S2-T2 · Signed container images + SBOM.**
CI builds the API image from the existing `Dockerfile` on tags, pushes to GHCR, signs with cosign (keyless/OIDC), attaches an SBOM (syft, SPDX-JSON) as an attestation. Document verification (`cosign verify ...`) in `deploy/INSTALL.md`; update the Helm chart default `image.repository` to GHCR.
*AC:* `cosign verify` succeeds per the documented command; SBOM attestation downloadable; Helm install pulls the signed image.

**S2-T3 · Static analysis + secret hygiene.**
Enable CodeQL (JS/TS + Python) and gitleaks in CI; triage every finding to fixed / dismissed-with-reason.
*AC:* both run on PRs; zero untriaged findings on main.

**S2-T4 · Open-core boundary ADR.**
With the tech lead, write `docs/adr/0001-open-core-boundary.md`: open = PDP spec, SDKs, gateway, core/seal/verify, reference decision engine; commercial-candidate = regulation packs, console, assurance/underwriter feed. Juniors draft, lead decides.
*AC:* ADR merged; repo layout section of README references it.

**S2-T5 · Seed the contributor funnel.**
File 15–20 well-specified `good-first-issue`s from this roadmap's small items (each with context, files, AC). Labels, a project board mirroring roadmap phases, and issue links from `docs/LIMITATIONS.md` items to their tracking issues.
*AC:* board exists; every LIMITATIONS entry links to an open issue with a task ID.

**S2-T6 · One-time prettier normalization; flip the gate to blocking.** *(added by amendment — see §7, amendment 2)*
A single, purely mechanical PR: `pnpm format:write` across the repo, then flip the CI `format:check` step from report-only to blocking. Formatting is not a crypto *design* change, so `packages/core` is included — but the PR must **prove** it is whitespace/format-only: `git diff -w` over the PR is empty (byte-level changes are whitespace/punctuation reflow only), full suite green, typecheck green, zero manual edits mixed in. No other work rides along in this PR.
*AC:* `pnpm format:check` passes repo-wide and is a blocking CI step; `git diff -w main...HEAD` on the PR is empty; suite green.

**Sprint 2 demo:** `pip install pharos-sdk` + `npm install @pharos/sdk` live; `cosign verify` live; the project board tour; Dependabot queue at zero with the triage policy shown.

---

## PHASE 1 — Trust core (Sprints 3–4)

The product's one-sentence pitch is "litigation-grade proof." Today the signing keys live on local disk and the timestamp authority is simulated. This phase makes the trust claims literally true. **All work in this phase implements existing interfaces — `SigningProvider` (`packages/core/src/signing/provider.ts`) and the TSA seam in `packages/evidence/src/timestamp.ts`. If you find yourself changing those interfaces rather than implementing them, stop and talk to the tech lead.**

### Sprint 3 — "Real KMS"

**S3-T1 · AWS KMS SigningProvider.**
New file `packages/core/src/signing/awsKms.ts` implementing the full `SigningProvider` interface with AWS KMS asymmetric keys. Note Ed25519 is not supported by AWS KMS — use `ECC_NIST_P256` / `ECDSA_SHA_256`, which means `PublicKeyEntry.algorithm` needs a second enum value (`"ecdsa-p256"`); thread that through `packages/core/src/chain/verify.ts` and the external verifier (`scripts/external-verify.ts`) so offline verification handles both algorithms. Key naming: one KMS key per `keyName`, versions via alias rotation, mapped onto the existing `<name>#v<n>` keyId scheme. `rotate()` mints a new key and repoints the alias; old keys remain enabled for verify. Config: `PHAROS_KMS_PROVIDER=aws-kms` plus region/credential envs in `packages/config`; remove the "refuses to boot" placeholder behavior.
*AC:* full `SigningProvider` conformance test suite (write it — it runs against LocalKms AND AwsKms); integration tests green against **LocalStack KMS** in CI (add a LocalStack step next to the MinIO step in `ci.yml`); `pnpm demo:durability --verify` passes end-to-end with `aws-kms` + LocalStack; the Helm values placeholder note is deleted because it's no longer true.

**S3-T2 · KMS failure-mode policy.**
Decide and implement what happens when KMS is unreachable at seal time. The invariant "no verdict without a sealed record" means **KMS down ⇒ the action cannot be governed** ⇒ the API returns 503 with a distinct error, and the SDKs' local fail-mode (reversible→fail-open with a locally-logged stub, irreversible→fail-closed) takes over. Add a circuit breaker + `pharos_kms_unavailable_total` metric in `packages/observability`.
*AC:* integration test: kill LocalStack mid-run → API 503s, SDK conformance tests (TS + Python) show correct local fail-mode behavior, metric increments; behavior documented in `docs/operations.md`.

**S3-T3 · Key migration + rotation runbook.**
A documented, tested path from local-kms keys to aws-kms for an existing tenant chain: old records keep verifying under old (Ed25519) public keys in the published keyset; new records sign under KMS. Because each record embeds its `keyId` and the keyset is additive, this should need **no data migration** — prove it. Write `docs/runbooks/key-rotation.md` covering scheduled rotation and compromise-triggered rotation.
*AC:* integration test: seal N records under LocalKms → switch provider → seal N more → `verifyChain` green genesis-to-head → external offline verifier green with the merged keyset.

**S3-T4 (stretch) · Vault Transit provider.**
Same conformance suite, `packages/core/src/signing/vaultTransit.ts` (Vault supports Ed25519 natively). Only start if S3-T1..T3 are merged.
*AC:* conformance suite green against a Vault dev container.

### Sprint 4 — "Real time, real threat model"

**S4-T1 · RFC 3161 timestamp authority client.**
Replace the simulated TSA in `packages/evidence/src/timestamp.ts` with a real RFC 3161 client: build the TimeStampReq (DER/ASN.1 — use `pkijs`/`asn1js`; do NOT hand-roll ASN.1), POST to a configurable TSA URL (default a free TSA, e.g. FreeTSA, for dev; document DigiCert/Sectigo for prod), verify the TimeStampResp signature against the TSA cert chain, store the full DER token in the anchor. Keep the simulated TSA as a `local` provider for tests. Extend the offline verifier to validate the embedded RFC 3161 token.
*AC:* anchor created against a live TSA in an integration test (network-marked, with the local provider fallback keeping CI hermetic — but the CI gate still requires the local-provider tests to run); `scripts/external-verify.ts --bundle` validates a bundle containing a real token with no Pharos infrastructure.

**S4-T2 · Scheduled anchoring service.**
Chain heads are anchored on a schedule (default hourly) and on demand, per tenant; anchors are stored, exported in claims packs, and exposed in the console's chain view. Missing-anchor gaps become a `chainIntegrity` warning.
*AC:* integration test: seal records → run anchor job → export → offline verify proves "these records existed before time T"; `docs/evidence-seal.md` updated.

**S4-T3 · Threat model.**
Write `docs/security/THREAT_MODEL.md` (STRIDE over: ingestion API, cascade, seal path, WORM, KMS, gateway, console, SDKs). For each threat: mitigation-in-code (link file) or accepted-risk (tech lead signs). This is the document the Phase-5 pen testers scope from. Juniors draft from the codebase; tech lead reviews line-by-line.
*AC:* merged; every "mitigation" link points at real code or a real test; every accepted risk has an issue.

**S4-T4 · Crypto review prep package.**
Assemble `docs/security/crypto-review-package.md` for an external reviewer: canonicalization rules (`packages/core/src/chain/canonical.ts`), seal v1→v2 rationale (quote `provider.ts`), chain verify algorithm, selective-disclosure redaction design (`packages/core/src/redaction.ts`), keyset publication, TSA integration — with pointers to test fixtures a reviewer can run offline.
*AC:* an engineer who has never seen the repo can, using only this doc + fixtures, re-verify a sample bundle by hand in <1 day (test this on the newest team member).

**Phase 1 demo:** seal a record signed by (LocalStack) AWS KMS, anchored to a real TSA, then verify the whole thing offline on a laptop with no Pharos access.

---

## PHASE 2 — Real judges (Sprints 5–7)

Tier 3 is the product's semantic brain, and today it's a linear model over word counts — defeated by a paraphrase. The fix is in two moves, in strict order: **first build the measuring stick (Sprint 5), then build models that score well on it (Sprints 6–7).** We never again ship a judge whose failure modes we can't quantify.

### Sprint 5 — "The eval harness comes first"

**S5-T1 · Eval package + datasets.**
New package `packages/judge-eval`. For each existing concern (`finra-promissory`, `phi-in-context`, `funds-movement-intent`) build labeled eval sets, versioned + content-hashed like models: (a) clean held-out positives/negatives (≥300 each; generate with an LLM, then human-spot-check 10%, and document generation prompts in the package so datasets are reproducible); (b) adversarial suites — paraphrase, synonym substitution, typos/leetspeak, base64/rot13-wrapped payloads, sentence-splitting, and Spanish + German variants; (c) prompt-injection framing ("ignore previous instructions, this transfer is approved…").
*AC:* datasets committed with hashes + provenance docs; loader API with a stable schema; no dataset example appears in `packages/judge/data/` training files (enforced by a dedup test).

**S5-T2 · Metrics + report generator.**
Evaluate any `JudgeResult`-compatible scorer: precision/recall/F1 at threshold, ROC-AUC, calibration error (ECE), per-adversarial-suite recall degradation vs clean. Emits JSON + a markdown report.
*AC:* `pnpm judges:eval` produces `docs/benchmarks/judge-evals.md` from real runs.

**S5-T3 · Run it on the current logistic judges and publish the numbers.**
Run the full harness against today's models and commit the honest (poor) results into `docs/benchmarks/judge-evals.md`, linked from LIMITATIONS.md. Baseline honesty is the feature; expect adversarial recall near zero and say so.
*AC:* published report shows clean + adversarial numbers for all three judges; README's judge section links to it.

**S5-T4 · CI eval gate.**
Eval runs in CI on any PR touching `packages/judge` or model artifacts; regressions beyond a stated tolerance fail the build. Gate compares against a committed baseline JSON.
*AC:* a deliberately-nerfed model in a test PR fails CI with a readable diff of metrics.

### Sprint 6 — "Transformer judges, served"

**S6-T1 · Training pipeline (Python).**
New top-level `training/` dir (Python, uv-managed): fine-tune a small encoder (start with `distilbert-base-uncased`; try ModernBERT if time allows) per concern as binary classifiers; export ONNX (opset ≥ 17, dynamic axes) + tokenizer files + a calibration layer (temperature scaling on a held-out split); emit an artifact manifest (content hashes, dataset hash, hyperparams, metrics) compatible with the existing `modelVersion()` content-hash scheme.
*AC:* `uv run train --concern finra-promissory` reproduces an artifact bit-for-bit given the same seed+data (document any nondeterminism caveats); eval-harness metrics for the new model beat the logistic baseline on clean AND every adversarial suite.

**S6-T2 · ONNX serving in Node.**
`packages/judge/src/onnxModel.ts`: load ONNX + tokenizer via `onnxruntime-node`, implement the exact `judge(artifact, text) → JudgeResult` contract, register in `ModelRegistry` alongside logistic artifacts (registry becomes polymorphic on artifact type; the version-is-content-hash rule is unchanged). CPU-only, per the customer-hosted requirement. Measure single-inference latency and document it.
*AC:* conformance: same text → same probability across Node serving and the Python training-side scorer (tolerance 1e-4, tokenizer parity test); cascade integration tests green with ONNX judges swapped in; cold-start + warm p50/p99 inference latency published.

**S6-T3 · Model cards.**
`packages/judge/models/<concern>.CARD.md` per served model: data provenance, metrics incl. adversarial, calibration, intended use, known failure modes, version hash.
*AC:* readiness gate (`packages/assurance/src/readiness.ts`) gains a check: no judge serves without a card matching its current version hash.

### Sprint 7 — "The cascade tells the truth under load"

**S7-T1 · Honest re-benchmark.**
Rerun `scripts/bench-latency.ts` with ONNX judges at realistic concurrency on a documented reference box (and the Helm resource requests). Rewrite `docs/benchmarks/latency.md` with the new p50/p95/p99 and throughput; delete the 3.7ms headline everywhere it appears. If the 800ms envelope is threatened at target concurrency, that finding goes to the tech lead the day it's discovered — the deadline manager and fail-mode paths (`cascade.ts`, `deadline.ts`) exist precisely for this, and tuning (batching, session pooling, model size) is in scope.
*AC:* published benchmark from the real stack; README latency claims match it; deadline-breach behavior exercised in a load test, not just a fault-injection unit test.

**S7-T2 · Drift + calibration monitoring.**
Per-judge observability: score-distribution histograms, flag rates, calibration drift vs baseline (`packages/observability`); alert thresholds documented in the alert runbook. Feed the assurance engine's human-audit disagreements back as labeled eval examples (extend `packages/review/src/disagreement.ts` output into the judge-eval dataset format).
*AC:* Prometheus metrics visible per judgeVersion; a synthetic drifted-traffic test trips the alert; disagreement→eval-example pipeline has a test.

**S7-T3 · Judge lifecycle runbook.**
`docs/runbooks/judge-lifecycle.md`: retrain → eval gate → card → shadow (run new judge in shadow against live traffic, compare) → promote → rollback. Wire shadow mode through the registry (serve both, record both, act on active).
*AC:* shadow-mode integration test: new version shadows, divergence is recorded on the ActionRecord's verdict context without affecting decisions; promotion + rollback each happen with a one-line config change.

**Phase 2 demo:** live: a paraphrased FINRA-promissory message that sails past the old logistic judge gets flagged by the transformer judge; the eval report and new latency benchmark on screen.

---

## PHASE 3 — Integration surface (Sprints 8–9)

Platform teams will not insert a fragile bespoke proxy into their money path, and policy teams will not adopt a bespoke policy DSL. This phase meets the ecosystem where it is.

### Sprint 8 — "A gateway you'd actually deploy"

**S8-T1 · Durable held requests.**
Replace the gateway's in-memory `held` Map (`services/gateway/src/gateway.ts`) with a Postgres-backed store (new `heldRequestStore` in `packages/storage`, referencing the escalation id; body size-capped and encrypted at rest with a tenant data key). Exactly-once resume remains anchored on the existing server-side claim.
*AC:* integration test: escalate → **kill and restart the gateway process** → approve → request forwards exactly once; duplicate resume attempts rejected; LIMITATIONS entry deleted.

**S8-T2 · Header + body correctness.**
Forward request headers per an explicit config (default: pass all except hop-by-hop and `Host`; always strip Pharos auth); preserve method/query/body bytes exactly (no JSON re-serialization — today's `JSON.stringify(req.body)` mangles non-JSON bodies); stream large bodies; propagate response headers/status verbatim.
*AC:* conformance tests: authenticated upstream (Bearer + custom headers) works through the gateway; binary body round-trips byte-identical; a streaming (chunked) upstream response streams to the client.

**S8-T3 · Multi-target, multi-tenant routing.**
Config-file-driven route table (host/path-prefix → target + tenant + agent + action-mapping), replacing the single `target` constructor option. Per-route mandate binding.
*AC:* one gateway instance governs two agents to two upstreams under two tenants in an integration test; config hot-reloads (SIGHUP) with a test.

**S8-T4 · MCP middleware.**
New adapter in `packages/middleware`: an MCP server-side wrapper that governs tool calls (tool call = action; tool result held on escalate) passing the existing middleware conformance contract, plus an example under `examples/`.
*AC:* conformance suite green for the MCP adapter; example demonstrates block + escalate/resume against a demo MCP tool.

### Sprint 9 — "Speak the standards"

**S9-T1 · Cedar policy backend (ADR first).**
Half-day ADR (`docs/adr/0002-policy-interop.md`, tech lead decides): Cedar vs OPA/Rego as the interop target — default assumption Cedar via `@cedar-policy/cedar-wasm`. Then: a `PolicyArtifact` variant whose rules are Cedar policies evaluated behind the existing `evaluateArtifact` seam, an exporter (best-effort compile of existing `Condition` rules to Cedar with an explicit unsupported-list), and dry-run/shadow lifecycle parity.
*AC:* the mandate-limit and amount-threshold demos pass with Cedar as the rule engine; a Cedar policy goes through compile→dry-run→active→rollback; ADR merged.

**S9-T2 · OTel + OCSF export.**
Map `ActionRecord` to OpenTelemetry (spans per cascade tier via `packages/observability/src/tracing.ts` upgraded to the real OTel SDK, GenAI semantic conventions where applicable) and an OCSF event class mapping for SIEM export (JSON, documented field-by-field in `docs/integrations/ocsf.md`).
*AC:* traces visible in Jaeger in the dev compose; an exported OCSF batch validates against the OCSF schema; both documented.

**S9-T3 · Envoy ext_proc spike (timeboxed: 3 days).**
Prototype the gateway's govern-and-hold semantics as an Envoy external processor; write up feasibility, latency, and escalate/hold ergonomics in `docs/adr/0003-envoy-ext-proc.md` with a go/no-go recommendation. No production code.
*AC:* ADR with measurements; demo recording; decision recorded for Phase-4+ scheduling.

**Phase 3 demo:** an unmodified agent with an authenticated upstream governed through the restart-safe gateway; the same policy expressed in Cedar; the action visible in Jaeger and as an OCSF event.

---

## PHASE 4 — Scale & reliability (Sprints 10–11)

### Sprint 10 — "Know the ceiling; behave when degraded"

**S10-T1 · Chain-head contention benchmark.**
The per-tenant `tenant_chain_head` serializes appends by design. Build a benchmark (extend `scripts/bench-latency.ts`) measuring per-tenant sustainable seal throughput and cross-tenant scaling (1, 10, 100 tenants), under contention. Publish in `docs/benchmarks/throughput.md` with the architectural explanation and the documented ceiling.
*AC:* published numbers; an alert fires when a tenant approaches a set % of measured ceiling (`packages/observability`); README quotes the honest per-tenant figure.

**S10-T2 · Backpressure.**
Bounded ingestion: queue-depth metrics, 429 + `Retry-After` when saturated, SDKs honor `Retry-After` (TS + Python + conformance tests).
*AC:* load test drives the API into 429s; SDKs back off correctly; no seal-path invariant violated at saturation (verify chain after the storm).

**S10-T3 · Dependency-degradation matrix.**
A table in `docs/operations.md` — for each dependency (Postgres, Redis, S3/WORM, KMS, TSA) × state (down, slow, flapping): expected API behavior, SDK behavior, metrics, operator action. Every cell gets an integration test where feasible (Redis down must degrade gracefully — cache only; Postgres down ⇒ 503 + SDK local fail-mode; S3 down ⇒ define and implement: seal fails ⇒ 503, same as KMS — no "we'll write WORM later" queue without an RFC, because it breaks the transactional invariant).
*AC:* matrix documented; ≥8 cells covered by chaos-style integration tests (toxiproxy in compose for "slow").

**S10-T4 · Per-policy-class fail-mode configuration.**
Today fail-open/closed is decided solely by reversibility (`cascade.ts#failMode`). Make it configurable per action class / policy pack (compliance wants fail-closed-everything for wires; SRE wants fail-open for read-only), with the default unchanged and the choice sealed into the record's `failMode` context.
*AC:* config schema + tests for override precedence; the sealed record shows which policy set the fail mode; docs updated.

### Sprint 11 — "Prove resilience on a schedule"

**S11-T1 · Failover exercise as code.**
Script the region-failover exercise described in `docs/operations.md` (primary loss → promote replica → chain re-verify green → zero evidence loss) against a compose/k3d environment, and run it on a weekly scheduled CI workflow that files an issue on failure.
*AC:* green scheduled run visible; deliberately corrupting a record makes the run fail with a precise diagnostic.

**S11-T2 · Load-test suite + SLOs.**
k6 (or equivalent) scenarios: steady-state, burst, escalation-heavy, gateway-proxied. Define and document SLOs (verdict latency p99, seal success rate, escalation resume time) in `docs/operations.md`; CI perf job (scheduled, not per-PR) trends results.
*AC:* SLOs documented with current measured values; a perf regression >20% on the weekly run files an issue automatically.

**S11-T3 · Upgrade path test.**
Prove v0.1 → current upgrades in place: run old image, write records, upgrade containers, run migrations (`packages/storage/src/migrations.ts`), verify chain + old records + old claims packs still verify offline.
*AC:* automated upgrade test in CI on tags; `deploy/INSTALL.md` gains an Upgrades section.

**S11-T4 · WORM/Postgres reconciler.**
The wormStore docs mention detecting orphans (written to WORM, never committed to Postgres). Build the reconciler job + metric + runbook; schedule it in prod deploy templates.
*AC:* test: crash injected between WORM put and Postgres commit → reconciler flags the orphan; runbook documents resolution.

**Phase 4 demo:** the weekly failover run, live; the throughput doc; a saturation load test with SDKs backing off and the chain verifying green afterward.

---

## PHASE 5 — External attestation & pilot readiness (Sprint 12 → ongoing)

Engineering builds the scaffolding; humans (tech lead / founders) execute the external parts. Track every external gate as an issue with an owner.

**S12-T1 · Pen-test readiness.** Scope doc from the threat model (S4-T3); a disposable, seeded test environment (one compose command); rules of engagement. *AC:* an external firm could start Monday.
**S12-T2 · SOC 2 evidence tooling.** Map the claimed controls (`docs/compliance/soc2-and-procurement.md`) to automated evidence collection (CI logs, access reviews, alert history exports). *AC:* evidence for ≥10 controls generated by script, not screenshots.
**S12-T3 · Design-partner kit.** One-command pilot install (Helm umbrella or hardened compose), onboarding checklist, a "first governed action in 30 minutes" tutorial using the published SDKs, and the assurance dashboard fed by their real traffic. *AC:* an internal "fake customer" run-through completes in ≤1 day.
**S12-T4 · Billing reconciliation hardening.** Property-based tests that invoices reconcile exactly to metered usage under concurrency, clock skew, and retries (`packages/billing`, `test/billing.test.ts`). *AC:* fuzz run of 10k random usage streams reconciles to the cent.
**External gates (not code, tracked as issues):** commissioned pen test · SOC 2 Type I → II · outside-counsel review of `docs/legal/admissibility.md` · independent crypto review (package from S4-T4) · 2–3 design partners live · npm/PyPI org verification.

---

## 5. Risk register (top items — review at every sprint planning)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Transformer judges blow the latency envelope on CPU | Med | High | S7-T1 measures early; deadline manager + fail modes already engineered; fallback = smaller distilled models, batching, or raising the envelope honestly |
| 2 | npm/PyPI names unavailable | Med | Med | Check day 1 of Sprint 2; naming fallback decided by lead |
| 3 | AWS KMS lacks Ed25519 → dual-algorithm verification bugs | Med | High | S3-T1 conformance suite runs both algorithms; external verifier fixtures for both |
| 4 | Junior-drafted threat model misses classes of attack | High | Med | Tech-lead line-by-line review; pen test (S12) is the backstop |
| 5 | Eval datasets leak into training data → inflated metrics | Med | High | Dedup test in S5-T1 is CI-enforced; dataset provenance documented |
| 6 | Cedar interop can't express existing packs | Med | Med | ADR + explicit unsupported-list; homegrown DSL remains the default engine |
| 7 | Scope creep from the console/UI | High | Low | Console is explicitly out of scope until Phase 5 |
| 8 | Solo-founder history: undocumented intent in subtle code | Med | Med | When intent is unclear, write a characterization test of current behavior BEFORE changing it |
| 9 | Unattended dependency majors (zod, jose, fastify ecosystem) drift the trust path | Med | Med | S2-T0 triage policy; majors reviewed one at a time with migration notes; jose/zod treated as trust-path changes |

## 6. What NOT to do (read twice)

- Do not "improve" the canonicalization, hashing, chain, or seal formats opportunistically. RFC or leave it.
- Do not add a queue/buffer that lets a verdict return before its record is durably sealed. That trades away the product.
- Do not weaken, skip-list, or conditionalize the CI "integration tests must run" gate to get a PR green.
- Do not blind-merge Dependabot majors — see S2-T0. `jose` and `zod` sit on the token-verification and validation paths.
- Do not train on, or even open, the eval datasets while working on models. Metrics you can't trust are worse than no metrics.
- Do not add heavyweight dependencies (an ORM, a message broker, a service mesh) without an ADR. The dependency-light posture is part of why customer-hosted works.
- Do not touch `apps/console` except where a task explicitly says so.
- Do not let a doc claim outrun the code — including in your own PR descriptions.

---

## 7. Amendment log

Amendments proposed in the Sprint 1 final report, ruled on by the tech lead, plus one finding from post-sprint verification. Per §0, this is the record of every deviation from v1.0.

1. **Test-count baseline (accepted).** The v1.0 snapshot said 154 TS tests; main had advanced two PRs (#1–#2) before Sprint 1 started, so the true baseline was 157 TS + 10 Python. §1.1/§1.2 now quote 157 *as of v0.1.0* and treat counts as floors. Lesson: the roadmap quotes point-in-time facts; verify them against HEAD at sprint start.
2. **Prettier enforcement (accepted, scheduled).** Sprint 1 shipped prettier as a non-blocking report — correct call: a repo-wide reformat mixed into a feature sprint would have been an unreviewable diff across crypto files. The one-time normalization + gate flip is now **S2-T6**, as a standalone mechanical PR whose whitespace-only nature is proven by `git diff -w` being empty.
3. **CODEOWNERS branch protection (accepted, deferred).** Required-review protection with a single maintainer would deadlock all merges. Noted in §2; enable when a second maintainer exists.
4. **Truth-pass summary reconciliation (accepted, fixed in #22).** The S1-T3 checklist corrected six claims but missed the Status section's own "remaining items are not code" summary, which the new LIMITATIONS.md contradicted. Ground rule 6 now says: truth passes must re-read summary statements, not just itemized claims.
5. **Dependabot triage (new, from post-sprint verification).** Enabling Dependabot in S1-T4 immediately opened 12 PRs (#8–#18, #20), including majors on trust-path libraries (`zod` 3→4, `jose` 5→6). Added **S2-T0** (triage policy + first sweep) and risk-register item 9. Lesson: any task that turns on an automated PR source must include its triage policy in the same task.

*Sprint kickoff prompts are supplied by the tech lead per sprint (Sprint 1's `SPRINT1_KICKOFF_PROMPT.md` was delivered outside the repo); each prompt executes one sprint of this document.*
