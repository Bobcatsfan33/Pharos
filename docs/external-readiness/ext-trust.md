# EXT-TRUST — KMS, TSA, and legal trust onboarding

Tracker: [#165](https://github.com/Bobcatsfan33/Pharos/issues/165).

Security and PKI must approve real production KMS keys, aliases, policies, grants, custody,
separation of duties, monitoring, and rotation/rollback evidence. The TSA endpoint and certificate
chain must be obtained independently of evidence payloads; its SHA-256 pin, expiry monitoring,
availability, renewal, and rotation exercise must be approved for the deployment.

Outside counsel must review the actual jurisdiction, retention, litigation-hold, trusted-time,
signature, and admissibility assumptions. Approval requires retained artifact digests and a signed
decision from named Security, PKI, and Legal authorities. Emulators, example configuration, and
repository legal drafts are inputs only.
