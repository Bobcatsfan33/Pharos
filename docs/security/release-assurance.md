# API image release assurance

Pharos promotes an API image by immutable digest, never by tag. Pull requests
and `main` build the same Dockerfile and digest-pinned Node base used for a
release, then prove:

- the image records the approved base digest and runs as the `node` user;
- Node starts with no network, no capabilities, a read-only root filesystem,
  `no-new-privileges`, and only a bounded `noexec` temporary mount;
- Syft can inventory the complete image into SPDX JSON;
- Trivy finds no fixable High or Critical OS or library vulnerability.

The SBOM and machine-readable vulnerability report are retained for every
assurance run. A scanner ignore is not an exception process. Any future waiver
must name the CVE and exact digest, document reachability and compensating
controls, identify an owner, and expire within 30 days.

## Release

A repository ruleset must restrict `v*` tag creation to release maintainers,
and the `production-release` environment must require independent approval.
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
