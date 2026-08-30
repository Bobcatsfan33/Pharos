# Governance

KEEL is an open-source project under the Apache-2.0 license. This document records how
decisions are made and how the project stays maintainable over time.

## Roles

- **Contributors** open issues and pull requests. Anyone can be a contributor.
- **Maintainers** review and merge PRs, triage issues, and cut releases. Maintainers own
  the security-sensitive paths listed in `CODEOWNERS` (substrate, executor, CI/release
  config).

The current maintainer is [@Bobcatsfan33](https://github.com/Bobcatsfan33).

## How decisions are made

- **Ordinary changes** (features, fixes, docs) land by pull request once CI is green and
  a maintainer approves. The automated gate set (`docs/SDLC-POLICY.md`) is the first
  reviewer; a maintainer is the second.
- **Architectural changes** — anything that touches an invariant (the event envelope,
  the layer contracts, determinism/durability guarantees, or a stable surface in
  `docs/STABILITY.md`) — require an **ADR** in `docs/adr/` describing the decision and
  its consequences, and maintainer sign-off.
- **Disagreements** are resolved by discussion on the issue/PR; if unresolved, the
  maintainers decide. The bias is toward the documented strategy (`docs/STRATEGY.md`):
  the substrate is the moat, and claims ship only after proof.

## Becoming a maintainer

KEEL currently has a single maintainer, which is also why branch protection is
*configured but not enabled* (requiring a non-author review with no second reviewer
would block every merge — see `docs/SDLC-POLICY.md`). We actively want a second
maintainer; this is the project's main continuity risk.

A contributor becomes a maintainer by a track record of high-quality, merged
contributions and demonstrated judgment on the core guarantees. The path:

1. Land several non-trivial PRs (a framework adapter via `docs/ADAPTER-AUTHORS.md` is an
   excellent start — it touches the contracts without risking the substrate).
2. Help triage issues and review others' PRs.
3. An existing maintainer nominates you; existing maintainers agree.

The moment a second maintainer is added, branch protection is a one-command change:
`bash scripts/org/protect.sh keel` (required code-owner review, required status checks,
no force-push, signed commits). At that point the governance described here is fully
*enforced*, not just documented.

## Releases

Releases are tag-driven and publish to PyPI via Trusted Publishing (OIDC), in a
protected environment that requires approval by someone other than the tag pusher. See
`docs/SDLC-POLICY.md` for the full release and vulnerability-handling process.
