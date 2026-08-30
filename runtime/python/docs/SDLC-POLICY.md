# KEEL — Secure SDLC Policy

One page recording how KEEL is developed and the gates enforced on every change.
This is the input to an SSDF (NIST SP 800-218) self-attestation.

## Development model

KEEL is developed with **AI-assisted engineering**: changes are authored with an AI
coding agent under human direction and land through pull requests. No change reaches
`main` except via a PR that passes the automated gates below. The architecture
(L1–L5 layers with `import-linter` contracts, `mypy --strict`, property/chaos tests)
is the primary defense against regressions; AI-authored code is held to the same gates
as any other.

## Enforced gates (every PR — `.github/workflows/ci.yml`)

| Gate | Tool | Blocks merge |
|------|------|--------------|
| Lint | `ruff` | yes |
| Types (L1–L5) | `mypy --strict` | yes |
| Layer contracts | `import-linter` | yes |
| Unit + property + chaos tests | `pytest` | yes |
| Performance budgets | trace-overhead + viewer-render benchmarks | yes |
| Dependency audit | `pip-audit` | yes |
| SAST | `bandit -ll` (medium+) | yes — suppressions require an inline justification |
| SBOM | CycloneDX (`cyclonedx-py`) | artifact, 90-day retention |
| Code scanning | CodeQL `security-extended` | findings to the Security tab |

Supply chain (on the first-party image, `.github/workflows/security.yml`): CodeQL,
Trivy image gate (HIGH/CRITICAL, `.trivyignore` is the only waiver path), CycloneDX
SBOMs, cosign keyless signing, and SLSA v1 provenance — via the org reusable workflow
`Bobcatsfan33/.github`.

## Branch protection (SH-2)

Branch protection is defined **as code** in `scripts/org/protect.sh`: required PR
review by a code owner who is not the author, required status checks (`ci`,
`security-suite / build-scan-sign`), no force-push, no deletion, and signed commits.

**Current status:** *configured but not yet enabled.* KEEL has a single maintainer,
and enabling required reviews with no second reviewer would make every merge
impossible. `CODEOWNERS` and `protect.sh` are committed so that protection becomes a
one-command change (`bash scripts/org/protect.sh keel`) the moment a named second
maintainer is added. Until then, continuity risk is mitigated by: the full automated
gate set above, signed-off PRs, and a public, reproducible history.

## Release process (K-2)

Releases are **tag-driven** (`v*` → `.github/workflows/release.yml`): the tag must
match `pyproject.toml`'s version; the package is built and published to PyPI via
**Trusted Publishing (OIDC)** — no long-lived PyPI token exists anywhere. Publishing
runs in a protected `pypi` environment requiring approval by someone other than the
tag pusher.

## Vulnerability handling

`pip-audit` and CodeQL run on every PR. A confirmed vulnerability is triaged within
the normal PR flow; a Trivy/`pip-audit` waiver is only ever an entry in `.trivyignore`
(image) with a justification, never a blanket skip.
