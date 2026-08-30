# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue for a
vulnerability.

- Use GitHub's **private vulnerability reporting**: the *Security* tab →
  *Report a vulnerability* (GitHub Security Advisories) on this repository.

Include enough to reproduce: affected version/commit, a description, and a proof of
concept if you have one. You will get an acknowledgement, and we will work with you on a
fix and coordinated disclosure. Please give a reasonable window before any public
disclosure.

## Scope

In scope: the KEEL runtime (`keel/`), the CLI, the viewer, the published container
image, and the release/supply-chain workflows. Out of scope: vulnerabilities in
third-party model providers or frameworks reached through an adapter (report those
upstream), and issues requiring a trust level the threat model does not assume (e.g. an
attacker who already controls the host or the event store).

## What we already do

KEEL's secure-SDLC gates run on every PR (see `docs/SDLC-POLICY.md`): `pip-audit`,
`bandit` SAST, CodeQL `security-extended`, a Trivy image gate, CycloneDX SBOMs, and
cosign keyless signing + SLSA provenance on the released image. Secrets are redacted on
the trace bus before any event is persisted (`keel/substrate/redact.py`).

## Supported versions

KEEL is pre-1.0; security fixes target the latest released version and `main`. See
`docs/STABILITY.md` for the versioning and support policy.
