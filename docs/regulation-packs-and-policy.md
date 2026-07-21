# Regulation packs & the policy lifecycle (Sprint 6 — Codex)

Packs are the recurring-revenue content moat and the thing security platforms are
structurally bad at. Depth in two verticals beats breadth in six.

## Declarative, citation-level rules

A rule is JSON data ([`@pharos/policy` rules](../packages/policy/src/rules.ts)): a `when`
condition over deterministic fields **and** Tier-3 judge probabilities, a `decision`, a
regulatory `clause`, and an examiner-readable `description`. This unifies the cascade's
deterministic and served-model tiers behind one rule model, so a regulation pack is a
**versioned, signed artifact**.

### FINRA pack v2

Citation-level 2210 promissory/exaggerated-claim rules (judge-driven), 3110 supervision and
2150 funds-handling hooks for funds movement. [`finra-v2.ts`](../packages/policy/src/packs/finra-v2.ts).

### HIPAA pack v2

Minimum-necessary (164.502(b)), PHI-in-context via the Tier-3 judge, authorization-state
(164.508) external-disclosure block, and breach-notification triggers (164.400-414).
[`hipaa-v2.ts`](../packages/policy/src/packs/hipaa-v2.ts).

Every shipped rule carries its clause and renders an examiner-readable explanation into the
verdict (verified in `test/policy.test.ts`).

## Constrained-grammar policy compiler (v1)

This is a **constrained-grammar compiler**, not a general natural-language compiler: a
line-oriented grammar of a handful of plain-English patterns (block/escalate promissory or
PHI language; block/escalate/modify a subject over an amount; require human review for a
subject; block/escalate a subject when a field contains a phrase) maps to candidate rule sets
with confidence flags ([`compiler.ts`](../packages/policy/src/compiler.ts)). Statements
outside those patterns are returned as `unparsed` for a human to encode by hand. Compilation
**never auto-activates**: output is candidate rules requiring human approval, and the
lifecycle requires a dry-run and shadow pass before enforcement. See
[docs/LIMITATIONS.md](LIMITATIONS.md).

## Policy lifecycle

```
draft ──dry-run──▶ shadow ──divergence──▶ active ──rollback──▶ (prior version reactivated)
```

- **Dry-run / impact dashboard** — run a candidate against a historical traffic window and
  get the predicted verdict mix ([`simulate.ts`](../packages/policy/src/simulate.ts)).
- **Shadow mode** — decisions computed but not enforced; divergence vs the active policy
  reported. Activation is blocked until a policy has been through shadow.
- **Activation** — promotes the version and archives the previously-active one.
- **Rollback** — one status flip restores the prior version; the evidence chain is untouched
  (verdicts reference policies; records are immutable). Restores in well under a minute.

Active policies are folded into the cascade per request alongside the shipped packs, so a
tenant's compiled policy takes effect on the next verdict.

## Exit-criteria proof

`test/integration.codex.test.ts`: a policy document compiles, dry-runs against 12 historical
payments (predicting six blocks), ships in shadow (with divergence), is promoted to active —
after which a $45k payment blocks with the compiled, examiner-readable citation and the impact
prediction matches observed verdicts — then rolls back in well under a minute with the
evidence chain intact.

External content gates remaining: securities-regulation and healthcare-privacy consultant
review of the two packs; signing paid pilots.
