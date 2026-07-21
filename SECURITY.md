# Security Policy

Pharos sells trust. We treat security reports as first-class engineering work and
respond quickly. Thank you for helping keep Pharos and its users safe.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub Security Advisories:

1. Go to the repository's **Security** tab → **Advisories** → **Report a vulnerability**
   (or open <https://github.com/Bobcatsfan33/Pharos/security/advisories/new>).
2. Describe the issue, the affected component/version, and a reproduction if you have one.

This routes the report to the maintainers privately and lets us collaborate on a fix in a
temporary private fork.

If you cannot use GitHub Security Advisories, open a **minimal** public issue that contains
no exploit details and asks a maintainer to contact you privately.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement of your report | within 3 business days |
| Initial assessment (severity, affected versions) | within 10 business days |
| Fix or documented mitigation | as fast as severity warrants |
| Public disclosure | coordinated, **within 90 days** of the initial report |

We follow a **90-day coordinated disclosure** window. We will keep you updated on progress
and credit you in the advisory unless you prefer to remain anonymous. If a fix is not ready
by 90 days we will agree on next steps with you before disclosing.

## Supported versions

Pharos is pre-1.0. Security fixes land on the latest minor release line only.

| Version | Supported |
|---|---|
| 0.1.x | :white_check_mark: |
| < 0.1 | :x: |

Once 1.0 ships, this table will list the supported major/minor lines.

## Scope

In scope: the code in this repository — `packages/*`, `services/*`, `apps/console`,
`sdks/*`, `scripts/*`, and the deployment templates in `deploy/`.

Out of scope: third-party dependencies (report those upstream; we will bump them),
findings that require a pre-compromised host or physical access, and the simulated/dev-only
components documented in [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) (e.g. the local KMS
keystore and simulated TSA) when used outside their documented dev context.

## Disclosures

Published advisories will appear under the repository's
[Security Advisories](https://github.com/Bobcatsfan33/Pharos/security/advisories) page.
