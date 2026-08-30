# Changelog

All notable changes to KEEL are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning. Release notes for `vX.Y.Z` are extracted from the matching
`## X.Y.Z` section by the release workflow.

## 0.2.0 - 2026-06-12

First public release. The full Phases 1–4 runtime, plus the release and security
supply chain that makes KEEL consumable by an enterprise.

### Runtime (Phases 1–4)
- **Core (P1):** event-sourced durable executor (state is a fold over an append-only
  log), KIR intermediate representation, authoring API (`Agent`/`Task`/`Crew`), model
  providers (OpenAI/Anthropic/Ollama) with a normalized error taxonomy, structured
  output enforcement, the `keel` CLI, and a trace viewer.
- **Durability + observability (P2):** byte-identical + patched time-travel replay,
  worker leasing + scheduler, human gates with webhooks, a memory subsystem, OTel
  GenAI export, and Postgres/NATS adapters.
- **Cost governance + reliability (P3):** no-bypass budgets metered at the emit
  chokepoint (tenant→run→crew→node), cheap-first routing with validation-failure
  escalation, 429-storm resilience, a measured context compiler, cost simulation, and
  a viewer cost dashboard.
- **Evals, integration, governance (P4):** recorded-run eval harness (5 assertion
  types + flake detection), out-of-process sandboxed tools, HMAC webhook/NATS
  triggers, a boundary policy engine + RBAC, a hash-chained audit log, and a CrewAI
  importer.

### Supply chain & release
- Security CI: `pip-audit`, `bandit`, CycloneDX SBOM, and CodeQL on every PR.
- Tag-driven releases to PyPI via Trusted Publishing (OIDC; no stored token).
- First-party distroless, non-root container image (runner + viewer).
- Org reusable security workflow: Trivy image gate, cosign keyless signing, and SLSA
  v1 provenance.

[0.2.0]: https://github.com/Bobcatsfan33/keel/releases/tag/v0.2.0
