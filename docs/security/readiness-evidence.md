# Enterprise readiness evidence governance

`docs/enterprise-readiness.json` is a repository self-assessment. It is an engineering control,
not an independent audit, certification, authorization to operate, or production approval.

## Drift integrity

Every file cited by a control or completed external gate is listed exactly once in the manifest's
`evidenceSnapshot`, with a SHA-256 digest over its reviewed bytes. CI recomputes every digest and
fails if evidence changes without an intentional snapshot update, if a cited file is missing or a
symlink, or if the inventory contains uncited material.

After reviewing a legitimate evidence change, refresh the inventory and verify it:

```bash
node scripts/sync-enterprise-evidence.mjs
node scripts/verify-enterprise-readiness.mjs
```

The snapshot detects stale or accidental evidence substitution inside a proposed revision. It does
not make the repository its own independent assessor: a committer who can change both evidence and
the manifest can update both. Branch protection, CODEOWNERS review, signed release provenance, and
the external approvals below provide the surrounding change-control boundary.

## Approval separation

The current decision is `not-approved`, and `assessment.approval` must therefore be `null`. CI will
reject an `approved` decision unless all control gaps and blocking gates are closed and the manifest
contains:

- a named approver identity, role, and organization distinct from the preparer;
- an explicit `independentOfPreparer: true` assertion and approval date;
- a repository evidence path for the retained decision record, covered by the digest snapshot; and
- completion evidence, date, and a distinct approver for every completed external gate.

Those fields are validation requirements, not proof that a claimed identity is genuine. The release
authority must verify the approver and retained record through the organization's identity, GRC, and
signature systems before accepting the manifest. Pharos deliberately cannot self-issue those facts.
