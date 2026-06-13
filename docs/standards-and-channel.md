# GA, standards & the channel (Sprint 9 — Signal)

The endgame moats are network and standard. Platforms can copy features; they cannot easily
copy a spec the ecosystem adopted or a channel underwriters already trust.

## Open PDP specification

[PDP spec v1.0](spec/pdp-v1.md) is public with a conformance suite and an **independent
reference implementation** that conforms ([`@pharos/pdp-spec`](../packages/pdp-spec)). Pharos
is the reference commercial implementation. Standards engagement:

- **IETF** — submit the evidence-binding/recording-format for alignment with the agent
  audit-trail draft (the `evidenceBinding` format in the spec).
- **NIST AI Agent Standards Initiative** — engage on the verdict/contract and evidence model.

## AIUC-1 control mapping (accountability pillar)

| AIUC-1 accountability expectation | Pharos artifact |
|-----------------------------------|-----------------|
| Decisions are governed by policy at runtime | Tiered verdict cascade, citation-level packs |
| Every consequential action is recorded | Hash-chained, signed `ActionRecord` in WORM |
| Records are tamper-evident and verifiable | Offline chain + claims-pack verification |
| Human oversight is captured | Escalations + sealed tier-`human` verdicts |
| Risk posture is measurable | Risk profile v2 + Wilson-score assurance |

This positions Pharos as AIUC-1's accountability pillar (their data source), not their rival.
NAIC model-bulletin expectations are mapped equivalently (governance, monitoring, records).

## Marketplace & identity rails

- **AWS / Azure marketplace** listings (customer-hosted image + SaaS).
- **Identity rails** — mandates flow in from where they are minted: Okta for AI Agents and
  Microsoft Entra Agent ID are OIDC issuers Pharos already verifies
  ([identity-and-tenancy](identity-and-tenancy.md)); an agent's minted identity + scope maps
  to a Pharos mandate.

## GA commercial model

Published pricing (the three-part model implemented in [`@pharos/billing`](../packages/billing/src/index.ts)):

- **Platform subscription** (flat).
- **Per-recorded-action metering** (usage; reconciles to recorded usage exactly).
- **Pack subscriptions** (per active regulation/policy pack) and **risk-profile / underwriter
  feed** subscription.

## Insurer channel

Carriers/MGAs consume the versioned [underwriter feed](assurance-and-risk.md) and specify
Pharos telemetry for preferred terms. Co-marketed customer story (template): *"<Customer>, a
<vertical> firm, deployed Pharos to govern its agents; its measured risk profile (grade <X>,
verified accuracy ≥ <Y>%) earned preferred AI-liability terms from <Carrier>."*

## Proof assets (public at GA)

- The [latency benchmark](benchmarks/latency.md) (p99 < 800ms).
- The [admissibility white paper](legal/admissibility.md) (FRE 901, 902(13)–(14)).

## Remaining external gates (not code)

- ≥ 1 non-Pharos production PDP / framework adoption commitment (the conformance suite + a
  conforming reference implementation are shipped to enable it).
- ≥ 1 carrier formally referencing Pharos telemetry in underwriting criteria.
- 3 paying production customers across two regulated verticals; GA launch.
