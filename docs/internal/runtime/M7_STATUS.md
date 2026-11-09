# M7 — Adoptable and Built to Last — STATUS: code-complete; external gates are external

**Headline proof:** *External contribution merged; security/governance live; independent
review.*

Two of these three are, by definition, things the project cannot manufacture for itself
— a genuinely *external* contribution and a genuinely *independent* review must come from
other people. What M7 ships is everything that makes those happen: the adoptable surface,
the governance, and the longevity guarantees. The honest status is below.

## What shipped (code/docs done)

- **Contributor golden path** — `CONTRIBUTING.md`: setup, the full local gate sequence,
  the two load-bearing rules (downward-only imports, nondeterminism only through L1
  ports), and what makes a good change.
- **Governance, live in documentation** — `GOVERNANCE.md`: roles, how decisions are made
  (ADRs for invariant-touching changes), and an explicit path to a second maintainer —
  which is the one-command trigger (`scripts/org/protect.sh`) that turns branch
  protection from *configured* to *enforced*.
- **Security policy** — `SECURITY.md`: private vulnerability reporting via GitHub
  Security Advisories, scope, and the existing SDLC/supply-chain controls.
- **Stability & longevity contract** — `docs/STABILITY.md`: the schema-evolution
  guarantee (run on schema *n* replays on *n+1*, gated by the golden corpus), versioning,
  the enumerated **stable surfaces**, the deprecation policy, and supported runtimes.
- **A real, tested adapter-contribution path** — `docs/ADAPTER-AUTHORS.md` plus a new
  **Pydantic-AI adapter** (`keel/adapters/pydantic_ai.py`) wired into the conformance
  suite. This makes "an external contribution" mechanically real: adding a framework
  adapter is a small, well-scoped PR that touches only the stable contract, never the
  substrate, and is proven by `assert_conforms`. The adapter passes CI today.
- **Issue/PR templates** — `.github/ISSUE_TEMPLATE/*` (bug, feature, adapter; security
  routed to private advisories) and `.github/PULL_REQUEST_TEMPLATE.md` with the
  guarantee checklist.

## The external gates (cannot be self-certified)

These remain open by design — they require third parties, and fabricating them would
violate the project's own "claims ship only after proof" rule:

- **External contribution merged** — the path is built, documented, and demonstrated
  (the Pydantic-AI adapter is the worked example, and the adapter author's guide makes
  the next one a small PR). What's missing is a merge of a PR authored by someone outside
  the project. Status: *enabled, awaiting a real external contributor.*
- **Independent review** — a third-party security review / pen test. The SDLC and
  supply-chain controls (`docs/SDLC-POLICY.md`) are the input to it. Status: *not yet
  performed.*
- **Governance fully enforced** — requires a named second maintainer, at which point
  `bash scripts/org/protect.sh keel` enables required code-owner review. Status:
  *one command away once a second maintainer exists.*

## Net

Everything code-side for adoption and longevity is implemented, tested, and green. The
remaining items are inherently external and are documented honestly here rather than
checked off.
