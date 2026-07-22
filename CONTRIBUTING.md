# Contributing to Pharos

Thanks for your interest in Pharos. This guide covers local setup, how we work, and the
rules every change follows. It mirrors §1.2 and §2 of the engineering roadmap.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Prerequisites: Node.js ≥ 20, [pnpm](https://pnpm.io) 10.x, and Docker (for the local
Postgres / Redis / MinIO stack).

```bash
pnpm install
pnpm infra:up          # Postgres + Redis + MinIO via docker compose
cp .env.example .env
pnpm test              # all tests must pass before you start ANY task
pnpm api:dev           # API on :4000
```

If `pnpm test` is not fully green on your machine, stop and fix your environment before
doing anything else. See [`docs/ONBOARDING.md`](docs/ONBOARDING.md) for a verified
clean-machine transcript.

## Ground rules

1. **Green before and after.** `pnpm -r typecheck && pnpm test` must be green before you
   branch and before you open a PR. Do not weaken, skip-list, or conditionalize the CI
   "integration tests must run, not skip" gate to get a PR green.
2. **One task, one PR.** Branch `s<sprint>-t<task>-short-name` (e.g. `s3-t2-aws-kms-provider`).
   The PR description links the task ID and quotes its acceptance criteria as a checklist.
3. **No crypto invention.** You may *call* crypto (KMS SDKs, `jose`, `node:crypto`); you may
   not *design* crypto (new signing schemes, canonicalization, chain formats) without an RFC
   approved by a maintainer.
4. **The frozen schema stays frozen.** `ActionRecord` v1 does not change. New fields go
   through the schema-version machinery with migration adapters, behind an RFC.
5. **Every behavior claim gets a test.** If a doc says "restart-safe," there is a test that
   restarts the thing.
6. **Honest docs.** When you complete a change, update any doc it makes false. Overclaiming
   in docs is a P1 bug in this product. See [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).
7. **Secrets never in the repo.** `.env` files are local; CI uses GitHub secrets. Anything
   that looks like a credential in a PR fails review.

## Commit sign-off (DCO)

All commits **must** be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/). Sign off with:

```bash
git commit -s -m "feat(S3-T1): add AWS KMS signing provider"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer. CI rejects any PR whose
commits are missing this trailer. If you forgot, amend with `git commit -s --amend` (or
`git rebase --signoff` for multiple commits) and force-push your branch.

Use [Conventional Commits](https://www.conventionalcommits.org/) with the task ID:
`type(TASK-ID): summary`, e.g. `fix(S8-T2): preserve non-JSON request bodies through the gateway`.

## Pull requests

- Fill in the [PR template](.github/pull_request_template.md): task ID, AC checklist, and the
  "docs updated?" checkbox.
- Changes touching `packages/core`, `packages/storage`, or `packages/identity` require review
  from a maintainer (see [CODEOWNERS](.github/CODEOWNERS)).
- PRs that touch a publishable package need a changeset (`pnpm changeset`); CI enforces this.
  Docs-only PRs can use the `no-changeset` label.
- Keep PRs focused on a single task. Analyze the full commit history when writing the summary.

## Dependency updates (Dependabot triage)

Dependabot opens dependency-update PRs on a weekly schedule (config:
[`.github/dependabot.yml`](.github/dependabot.yml)). **Do not blind-merge them.** Triage by
category:

| Category | Policy |
|---|---|
| **Dev-dependency patch/minor** (grouped into one PR) | Merge when CI is green. No changeset needed — add the `no-changeset` label. |
| **Runtime-dependency patch/minor** | Merge when CI is green **after a skim of the changelog** for behavioral notes. `no-changeset` label. |
| **Any major (`x.0.0`)** | **One PR at a time.** Read the migration notes, get the full suite green, and make a deliberate human decision. Never batch majors. |
| **Trust-path libraries** — `zod` (schema validation), `jose` (OIDC/JWT verification) | Treated as a **trust-path change** even on a "routine" bump: full suite green **and a written justification in the PR** describing what on the validation/token-verification path was re-checked. |
| **`apps/console`-only deps** (`next`, `react`, `react-dom`, …) | The console is out of scope until Phase 5. Patches: merge if green. Majors (e.g. Next 16): **close with reason and defer** — they are not tested in CI and carry no product value yet. Deferred majors are `ignore`d in `dependabot.yml` with a tracking issue. |
| **GitHub Actions majors** | Grouped into one PR by `dependabot.yml`; merge when CI is green (they are CI infra, not the trust path). |

Rules of thumb:

- **Majors are never batched.** A Dependabot PR that bundles multiple majors (it can happen
  when a group spans a major bump) is closed; the group config is tightened to
  minor/patch-only so majors arrive individually.
- **Close-with-reason is a valid outcome.** Deferring or declining an update is a decision, not
  a failure — record why in the PR and, if it should not re-open, add an `ignore` entry.
- A Dependabot PR that only touches private packages does not need a changeset; the
  changeset gate failing on a stale Dependabot branch is fixed by `@dependabot rebase`.

## Getting help

Thirty minutes stuck → write down what you tried → ask in an issue or discussion. Two hours
stuck silently is the only way to actually fail here.
