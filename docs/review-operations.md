# Review operations (Sprint 4 — Watchroom)

The human tier is the stickiest surface in the product and the tier regulators explicitly
expect. Watchroom turns it into the compliance department's daily tool.

## Queue engine & routing

Each `escalate` verdict is routed ([`@pharos/review` routing](../packages/review/src/routing.ts))
to a queue by action class, risk, and regulation pack:

| Signal | Queue |
|--------|-------|
| HIPAA pack | `privacy-office` |
| FINRA pack | `registered-principal` |
| payment / funds / wire actions | `treasury-control` |
| export / PII | `privacy-office` |
| otherwise | `general` |

Routing also assigns a **priority** (1–4 by risk and blast radius), an **SLA deadline**
(15 min for P1 → 1440 min for P4), and a **four-eyes** flag for high-value irreversible
actions. Routing is pure and deterministic — unit-tested in `test/review.routing.test.ts`.

## SLA engine

`ReviewSlaService` ([reviewSla.ts](../services/api/src/reviewSla.ts)) sweeps for pending
escalations past their SLA and fires a **breach alert** for each. `findNewBreaches` marks
rows atomically, so every breach alerts exactly once. States: `ok` → `at_risk` (last 20% of
the window) → `breached`.

## Notifications

`ReviewNotifier` ([notifier.ts](../packages/storage/src/notifier.ts)) delivers per-queue
across email / Slack / Teams / webhook and records every delivery in an audit table, so
"every breach alert fired correctly" is verifiable from the database.

## Reviewer workspace & sealed human verdicts

A reviewer resolves an escalation (approve / modify / reject) with a required rationale; the
resolution **seals a tier-`human` evidence record** linking reviewer identity, rationale,
and the overridden machine context (implemented in Sprint 3, surfaced here). Four-eyes is
flagged per action class.

## Analytics & the feedback loop

[`@pharos/review` analytics](../packages/review/src/analytics.ts) computes median review
time, SLA attainment, queue depth, reviewer throughput, and the **measured** machine-vs-human
disagreement rate. Disagreement clusters become **draft rule candidates** for the policy
compiler ([disagreement.ts](../packages/review/src/disagreement.ts)) — closing the human
feedback loop. Surfaced in the console under Beam → Review ops.

## Exit-criteria proof

`test/integration.watchroom.test.ts` seeds **500 escalations**, routes them across queues,
drains the backlog with **three reviewer roles within SLA** (100% attainment in the timed
drill), fires **exactly one breach alert per past-due item** (idempotent across sweeps), and
produces rule candidates from the disagreement loop.
