# Readiness re-review packet — prepared 2026-11-15

`docs/internal/enterprise-readiness.json` carries `assessment.asOf: 2026-08-10` and
`assessment.reviewBy: 2026-11-08`. That date has passed, so
`node scripts/internal/verify-enterprise-readiness.mjs` fails:

```
enterprise readiness verification failed: enterprise readiness evidence expired on 2026-11-08
```

That failure is **accurate, not broken**: the assessment genuinely is past its review date. No
CI workflow runs the verifier (the reshape retired it as a gate and it is now maintained with
`scripts/internal/*.mjs`), so main is unaffected.

**The re-review is a human act and this document does not perform it.** It is the packet: what
changed under the assessment since 2026-08-10, so whoever signs it is not reading 46 diffs cold.
The `deploymentDecision` stays `not-approved` either way — that is not what has lapsed.

## What changed

**46 of the 65 hash-pinned evidence files** have commits since 2026-08-10. Grouped by what drove
them, largest first:

| Change | Evidence files touched | What a reviewer should know |
|---|---|---|
| Repository reshape | 19 | Planning artifacts moved to `docs/internal/`, and the self-assessment CI gate was retired — so the manifest is now maintained deliberately with the sync/verify scripts rather than enforced on every push. Paths in every control's `evidence` list moved with it. |
| Training supply chain hardened | 12 | Locked `uv` graph, `pip-audit` over the exported requirements on two Python legs, and a Python **3.11 floor** (#304) adopted to clear 12 filelock CVEs that had no fix on 3.10. Toolchain majors (torch 2.15, transformers 5.22, onnxruntime 1.31) landed in #337 with the parity gate passing. |
| README and positioning | 8 | The latency headline and the repository description were rewritten; no claim added that the code does not back. |
| Keel folded into Pharos Runtime | 10 | One product, one release boundary. `services/api/src/platform.ts` changed with it. |
| Runner pinning and Actions bumps | 18 | All 28 jobs pinned to `ubuntu-24.04` (#332) ahead of the Ubuntu 26 migration; three grouped Actions bumps, every ref still a commit SHA (`verify-action-pins`: 91 references). |
| Judge requalification on ONNX Runtime 1.30 | 5 | `packages/judge/models/manifest.json` qualified-runtime tuples, and the Node/Python parity gate at 1e-4. **No judge was promoted.** |
| MandateToken (schema 1.1.1) | 4 | ADR 0007; a new sealed field under `liability`, additive, with the schema-version machinery. |
| Structural judges, routing, parallel panel | 4 | Tier 3 became a typed panel; `STRUCTURAL_SEMANTICS_VERSION` now 4 after #329. |

Everything above is already reflected in the re-hashed snapshot in this branch
(`sync-enterprise-evidence.mjs`, 65 files, `evidenceSnapshot.generatedAt` advanced).

## What did NOT change

- `deploymentDecision` is still **`not-approved`**.
- All five external gates (`EXT-PENTEST`, `EXT-TRUST`, `EXT-OPERATIONS`, `EXT-COMPLIANCE`,
  `EXT-CUSTOMERS`) are still `open`, with `evidence: []` and no receipt. Each has a current
  status comment on its tracking issue (#164–#168).
- `docs/LIMITATIONS.md` still carries every open limitation. It gained entries over this
  period rather than losing them — §8 (structural checks that abstain), §9 (MandateToken),
  §10 (embedded mode is not WORM), §11 (what a Claude Code hook can see).

## The proposal

| Field | Current | Proposed |
|---|---|---|
| `assessment.asOf` | `2026-08-10` | `2026-11-15` |
| `assessment.reviewBy` | `2026-11-08` | `2027-02-15` |
| `assessment.deploymentDecision` | `not-approved` | `not-approved` (unchanged) |

A three-month cadence matches the previous interval (2026-08-10 → 2026-11-08) and lands before
the Ubuntu 26 runner migration and the next judge requalification, both of which will move
evidence again.

**Merging the PR that carries this is the review.** If the reviewer does not accept the dates,
the right outcome is to change them in the PR rather than merge it as proposed — the point of
the packet is that the dates are a decision, not a formality.
