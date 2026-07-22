# ADR 0001 — Open-core boundary

- **Status:** Proposed *(drafted by engineering per S2-T4; the tech lead / founders decide
  whether to accept — this ADR is not in force until its status is changed to "Accepted")*
- **Date:** 2026-07-21
- **Deciders:** Tech lead / founders
- **Tags:** licensing, packaging, go-to-market

## Context

Pharos is Apache-2.0 today (ADR-less), and the repository mixes components with very
different strategic roles: the trust primitives that must be open for anyone to verify, the
SDKs and spec that drive adoption, and the higher-level product surfaces that are the
commercial reason to buy rather than self-host.

We need a **written, durable boundary** that says which parts of the codebase are open source
and which are commercial-candidate, so that:

- future PRs land code on the correct side of the line without re-litigating it each time;
- the "litigation-grade proof" claim stays credible — the verification path a customer or
  court relies on must be open and independently auditable, not a black box;
- adoption levers (SDKs, the PDP spec, the gateway) stay frictionless and free;
- the business retains defensible, differentiated surfaces.

This ADR **only defines the boundary**. It does not change any license header, split the
repo, or set pricing. Those are follow-up decisions gated on acceptance.

## Decision (proposed)

Adopt an **open-core** model with the following boundary.

### Open (permissive OSS — Apache-2.0, stays free and self-hostable forever)

The trust substrate and everything a third party needs to integrate and to **independently
verify** evidence:

| Area | Packages / paths |
|---|---|
| Evidence trust core — schema, canonical hashing, seal, chain verify, redaction, signing abstraction | `packages/core` |
| Offline/third-party verification | `scripts/external-verify.ts`, published keyset format |
| Open PDP specification + conformance suite + reference implementation | `packages/pdp-spec`, `docs/spec/pdp-v1.md` |
| SDKs (adoption surface) | `packages/sdk-ts` (`@pharos/sdk`), `sdks/python` (`pharos-sdk`), `packages/middleware` |
| Zero-code integration gateway | `services/gateway` |
| Reference decision engine (Tier-1 rules + cascade scaffolding) | `packages/cascade`, the Tier-1 engine in `packages/core` |
| The storage/transactional write path needed to run the above | `packages/storage`, `packages/config`, `services/api` |

**Rationale:** trust you cannot inspect is not trust. The seal/verify path, the spec, and the
SDKs must be open or the core pitch collapses and adoption stalls. Keeping the reference
engine and gateway open is what lets a stranger "legally use, build, verify, and install"
Pharos (Phase 0 exit criterion).

### Commercial-candidate (may move to a separate license/repo/edition on acceptance)

The differentiated, higher-level product surfaces — the reasons an enterprise pays rather
than self-hosts:

| Area | Packages / paths |
|---|---|
| Regulation content packs (FINRA, HIPAA, …) as maintained, versioned artifacts | `packages/policy/src/packs/*` |
| Assurance engine + underwriter/insurer feed | `packages/assurance`, `packages/review` (analytics/feed portions) |
| Operator console | `apps/console` |
| Managed/multi-tenant SaaS operational tooling, billing/metering | `packages/billing`, SaaS-only ops |

**Rationale:** these are the maintained-content and product-experience surfaces where the
ongoing value is the upkeep and the UX, not the primitive. Making them commercial-candidate
does not weaken any verification claim, because verification depends only on the open core.

### Guiding rule for future PRs

> If a customer, auditor, or court must be able to run it to trust the evidence, it is
> **open**. If its value is maintained content, a managed experience, or a commercial
> integration, it is a **commercial-candidate**.

When in doubt, default to open and raise it in review.

## Consequences

- **If accepted:** a follow-up task splits licensing/editions along this line; the README
  repo-layout and this ADR become the canonical reference; new packages get placed
  deliberately. No code moves as part of *this* ADR.
- **Everything stays Apache-2.0 until a licensing change is separately decided.** This ADR
  does not relicense anything.
- **Risk:** drawing the line too aggressively toward commercial would undermine the trust
  pitch; too permissively would leave nothing defensible. The boundary above is
  deliberately conservative on the open side (core, verify, spec, SDKs, gateway, reference
  engine all open).
- **Open question for the deciders:** does `packages/policy` (the DSL/compiler/lifecycle
  engine, excluding the content packs) belong open (engine) with only the *packs* commercial,
  as drafted here? This ADR assumes yes — flag if not.

## Status history

- 2026-07-21 — Proposed (engineering draft, S2-T4).
