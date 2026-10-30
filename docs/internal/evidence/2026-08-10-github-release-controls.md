# GitHub release-control audit — 2026-08-10

## Scope

This live, read-only audit checked whether repository settings enforce the controls required by
`docs/security/release-assurance.md` before an external-assessment image can be published. The
target source revision is `ef11b3bdca94994fcea35f4f72028e985416b5b8`.

## Queries and observed state

The authenticated repository administrator queried:

```bash
gh api repos/Bobcatsfan33/Pharos/environments/production-release
gh api repos/Bobcatsfan33/Pharos/rulesets --paginate
gh api repos/Bobcatsfan33/Pharos/collaborators --paginate
```

GitHub returned:

- `production-release.protection_rules` is empty;
- `production-release.can_admins_bypass` is `true`;
- the repository ruleset collection is empty; and
- `Bobcatsfan33` is the only collaborator and has the `admin` role.

## Decision

**FAIL — the live release-control prerequisite is not implemented.** The workflow code can sign
and attest an image, but GitHub does not presently require an independent approval before that job
runs, and no ruleset protects the `v*` tag namespace. The sole collaborator cannot provide an
approval independent of the repository preparer.

Do not create or push a release or prerelease tag until all of the following are true:

1. a second, accountable release reviewer is granted the minimum required repository access;
2. `production-release` requires that reviewer (or an approved reviewer team), prevents
   self-review, and disallows administrator bypass;
3. an active tag ruleset protects `refs/tags/v*` from unauthorized creation, update, and deletion;
4. the live API queries above are rerun and retained with a passing result; and
5. the protected release is exercised and its approval, image digest, signature, attestations,
   SBOM, vulnerability result, provenance, and release receipt are retained.

This audit is repository-maintainer evidence, not an independent approval. It remains valid only
for the observed GitHub state at the time of the queries.

## Follow-up — 2026-08-12

After restoring authenticated repository administration, the maintainer implemented and verified:

- `main` branch protection with strict, GitHub-App-bound required checks; one approving review;
  stale-review dismissal; CODEOWNERS review; last-pusher separation; conversation resolution;
  administrator enforcement; and force-push/deletion denial;
- active tag ruleset `Protect v* release tags` (ID `20772878`) covering `refs/tags/v*`, restricting
  creation to repository administrators acting as release maintainers and preventing unauthorized
  creation, update, deletion, and non-fast-forward changes;
- `production-release` and `pharos` environment deployment policies restricted to explicit `main`
  and `v*` branch/tag patterns; and
- administrator bypass disabled on both release environments.

The follow-up queries were:

```bash
gh api repos/Bobcatsfan33/Pharos/branches/main/protection
gh api repos/Bobcatsfan33/Pharos/rulesets/20772878
gh api repos/Bobcatsfan33/Pharos/environments/production-release
gh api repos/Bobcatsfan33/Pharos/environments/production-release/deployment-branch-policies
gh api repos/Bobcatsfan33/Pharos/environments/pharos
gh api repos/Bobcatsfan33/Pharos/environments/pharos/deployment-branch-policies
gh api repos/Bobcatsfan33/Pharos/collaborators --paginate
```

**FOLLOW-UP DECISION: PARTIAL.** The repository and tag controls are now live and administrator
environment bypass is disabled. The remaining release-control blocker is genuine separation of
duties: `Bobcatsfan33` remains the only collaborator, neither environment has a required reviewer,
and no protected release exercise has yet produced an approval record and signed artifact evidence.
The npm trusted-publisher configuration must also be changed from no environment to
`production-release` before its newly protected workflow job can publish. The original prohibition
on release tags remains in force until an independent reviewer is added, configured on both release
environments, and the protected release exercise passes.
