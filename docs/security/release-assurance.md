# API image release assurance

Pharos promotes an API image by immutable digest, never by tag. Pull requests
and `main` build the same Dockerfile and digest-pinned Node base used for a
release, then prove:

- the image records the approved base digest and runs as the `node` user;
- the API TypeScript runtime starts with no network, no capabilities, a
  read-only root filesystem, `no-new-privileges`, and only a bounded `noexec`
  temporary mount;
- the runtime contains the API production dependency closure and excludes the
  console, Vitest, Vite, and other build/test tooling;
- Syft can inventory the complete image into SPDX JSON;
- Trivy finds no fixable High or Critical OS or library vulnerability.

The SBOM and machine-readable vulnerability report are retained for every
assurance run. A scanner ignore is not an exception process. Any future waiver
must name the CVE and exact digest, document reachability and compensating
controls, identify an owner, and expire within 30 days.

## Release

A repository ruleset must restrict `v*` tag creation to release maintainers,
and the `production-release` environment must require independent approval.
The live 2026-08-10 audit found that neither control is currently configured and that the sole
repository collaborator cannot act as an independent reviewer. See
[`2026-08-10-github-release-controls.md`](../evidence/2026-08-10-github-release-controls.md).
Do not create a release or prerelease tag until that audit is rerun with a passing result.
After the image gate passes, `.github/workflows/image.yml`:

1. publishes the tagged and commit-addressed image to GHCR;
2. records BuildKit `mode=max` provenance;
3. keylessly signs the resulting digest;
4. attaches an independently generated SPDX SBOM as a keyless attestation;
5. publishes GitHub build provenance for the same digest;
6. verifies the signature and SBOM against this exact repository, workflow,
   OIDC issuer, and tag ref; and
7. retains a receipt binding source revision, release tag, base digest, and
   image digest.

Every third-party release action is pinned to an immutable commit. The
Dockerfile default and workflow base must stay byte-for-byte identical; CI
rejects drift between them. The Corepack package-manager declaration also
binds pnpm 10.32.1 to its registry SHA-512 rather than trusting the version
string alone.

### External-assessment candidate

After the live release-control audit passes, use a semver prerelease tag such as `v0.3.0-rc.1`
when an independent assessor or SRE campaign needs a registry-pinned candidate. The tag then runs
this image workflow through the protected `production-release` approval boundary and produces a
signed, attested digest plus release receipt. The SDK release workflow classifies prerelease tags
and skips npm and PyPI publication; only an exact stable `vMAJOR.MINOR.PATCH` tag or an explicit
manual dispatch can publish SDKs.

Creating the prerelease tag is a release-management action, not a CI workaround. Record the
approved source commit and intended engagement before pushing it, then use the resulting image
digest—not the mutable tag—in pentest, operations, and customer evidence.

## Admission

Signature verification establishes origin, not production approval. Cluster
admission must require both:

- the exact workflow identity and GitHub OIDC issuer shown in
  [`deploy/INSTALL.md`](../../deploy/INSTALL.md); and
- an explicit allowlist entry for the change-approved image digest.

Do not authorize a mutable tag, a wildcard branch identity, or every image
that the workflow has ever signed. Retain the release receipt, verification
output, vulnerability report, SBOM, change approval, and deployment record as
one evidence set.
