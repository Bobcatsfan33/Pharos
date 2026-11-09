# Internal planning material

This directory holds the material that drives the project but is not user documentation:
roadmaps, sprint status, handoff packets, the enterprise-readiness self-assessment and the
evidence it cites. It is kept in the repository so the history stays auditable, and kept out of
`docs/` so a reader looking for how Pharos works is not reading how it was planned.

| Path | What it is |
|---|---|
| `engineering-roadmap.md` | The enterprise engineering roadmap (phases, sprint tasks, amendment log). |
| `prototype-roadmap.md` | The original ten-sprint prototype roadmap with milestone exit criteria. |
| `status.md` | Sprint-by-sprint history of what landed. |
| `handoff/` | Program handoffs — currently the judgement-family and primitives program. |
| `enterprise-readiness.json` | Machine-checked self-assessment: controls, external gates, evidence digests. The decision field is only ever changed by a human. |
| `readiness-evidence.md` | How the self-assessment is maintained and why it is not an audit. |
| `procurement-readiness.md` | The procurement decision record that the manifest points at. |
| `external-readiness/` | Packets for the external reviewers named in the manifest's gates. |
| `evidence/` | Dated verification transcripts cited by the manifest. |
| `release-notes/` | Long-form release notes; the canonical changelog is `CHANGELOG.md` at the root. |
| `runtime/` | Historical milestone and strategy notes from the runtime before it was folded into Pharos. |

Maintainer tooling for the manifest lives in `scripts/internal/`:

```bash
node scripts/internal/sync-enterprise-evidence.mjs      # refresh evidence digests after a reviewed change
node scripts/internal/verify-enterprise-readiness.mjs   # validate the manifest and its evidence
node scripts/internal/verify-external-gate-trackers.mjs # check each open gate still has a tracking issue
```

These are run on demand by a maintainer, not as a CI gate: a self-assessment cannot be its own
independent assessor, and the build should not fail on a document only a human can change.
