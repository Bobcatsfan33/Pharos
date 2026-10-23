---
"@pharos/storage": minor
---

Add the embedded storage backend (`buildEmbeddedStorage`): SQLite via `node:sqlite` for
operational state and chain heads, content-addressed never-overwritten record files on the
local filesystem, and in-process rate-limit counters — zero infrastructure. Seal-and-append
runs in one SQLite transaction with the record file fsynced before commit. Its
`EMBEDDED_EVIDENCE_POSTURE` states exactly what it guarantees: tamper-evident and
offline-verifiable, NOT WORM, no row-level security, per-process rate limits. A storage
conformance suite (`test/storageConformance.ts`) now runs the same cases against the
embedded and Postgres backends; `pnpm test:embedded` runs the zero-Docker suite.
