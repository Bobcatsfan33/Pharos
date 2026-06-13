# Assurance, risk profile & the underwriter feed (Sprint 7 — Beam Count)

This converts Pharos from a control into a pricing signal — the BitSight-of-AI-liability
position.

## Assurance engine (measured, not modeled)

Unreviewed verdicts are sampled into a human audit queue; the fraction reviewers uphold is
the measured accuracy. We report the **Wilson-score lower bound at 95% confidence**
([`wilson.ts`](../packages/assurance/src/wilson.ts)) — an honest "verified accuracy is at
least X" that tightens as the audit count grows (hence the ≥1,000-audit bar). There is no
modeled placeholder: the number comes from real audits ([`AssuranceStore`](../packages/storage/src/assuranceStore.ts)),
per-pack and per-tenant.

## Risk profile v2

Five posture metrics recomputed from sealed records — autonomy rate, irreversible mix,
policy-failure rate, blast radius, oversight coverage — plus Beam-side signals (escalation
rate, measured disagreement rate, assurance lower bound), combined into a continuous
composite score and grade ([`profile.ts`](../packages/assurance/src/profile.ts)).

## Readiness gate

The external-release checklist wired to live data ([`readiness.ts`](../packages/assurance/src/readiness.ts)):
chain completeness, mandate coverage, violation rate, and irreversibility controls. A failing
check **blocks an external release** (the underwriter feed) unless an **owner grants a recorded
exception**. The exception workflow is the escape hatch with accountability.

## Underwriter feed

A versioned (`1.0`), consent-gated risk-profile export ([`feed.ts`](../packages/assurance/src/feed.ts))
co-designed with carriers/MGAs: the posture metrics, the measured assurance bound, and the
Beam signals carriers said move premium. Feed changes are versioned like an API so a carrier
can pin a schema; the export is access-audited (the portfolio-monitor exchange-portal tier).

## Exit-criteria proof

`test/integration.beamcount.test.ts`: verified accuracy computes from **1,050 real audits**
with the confidence interval displayed (n, point, lower, upper, 95%); the **readiness gate
blocks the underwriter feed** for a tenant with unmandated consequential actions
(mandate-coverage failure), and an **owner exception unblocks** it — after which the versioned
feed releases with the measured assurance bound.

External gate remaining: two carriers/MGAs consuming the feed for a pilot insured and
confirming the schema in writing.
