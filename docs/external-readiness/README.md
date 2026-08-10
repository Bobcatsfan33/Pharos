# External readiness gate handoff

Pharos cannot self-issue the six approvals in this directory. Repository CI proves software
properties; it does not prove that an independent assessor, counsel, SRE authority, GRC owner, or
customer accepted a real deployment. Each packet defines the work product that the named external
owner must return before its blocking gate can close.

## Gate lifecycle

1. Pin the assessment to `assessment.assessedCommit` from the readiness manifest and, where
   applicable, an immutable image digest. A receipt for any other commit is rejected.
2. Give the owner the matching packet, repository evidence snapshot, and relevant deployment facts.
   When the engagement requires a runnable image, an authorized release maintainer creates a
   semver prerelease tag (`vMAJOR.MINOR.PATCH-rc.N`) from the assessed commit. The image workflow
   returns the signed digest and receipt; prerelease tags do not publish the npm or PyPI SDKs.
3. Execute the assessment outside the implementation team. Findings remain open until remediated,
   retested, or explicitly accepted by the authority named in the packet.
4. Retain confidential source artifacts in the approved GRC, legal, customer, or evidence vault.
   Do **not** commit penetration-test reports, customer data, legal advice, credentials, or private
   topology details to this repository.
5. Commit a sanitized receipt conforming to
   [`evidence-receipt.schema.json`](evidence-receipt.schema.json). The receipt records immutable
   digests and durable external locators for the retained artifacts, assessor and approver identity,
   scope, limitations, decision, and detached signature metadata.
6. Add the receipt path to the gate's `evidence`, set `evidenceReceipt` to that path, populate
   `completion`, refresh the evidence snapshot, and run:

   ```bash
   node scripts/sync-enterprise-evidence.mjs
   node scripts/verify-enterprise-readiness.mjs
   ```

7. An approver distinct from the repository preparer verifies the external locator, artifact digest,
   signature, authority, and scope before merging. Structured fields make omission visible; they do
   not make a claimed identity or signature genuine by themselves.

The manifest must remain `not-approved` until every blocking gate is complete and every partial
control has been closed with evidence. A green repository build never overrides that rule.
