---
"@pharos/storage": patch
---

Introduce storage ports (`EvidenceStorePort`, `TenantStorePort`, …, `StorageBackend`,
`EvidencePosture`) and `buildPostgresStorage`, the Postgres + S3 WORM + Redis backend
lifted out of the API composition root. Behaviour-preserving: the Postgres classes now
`implements` the ports they already satisfied, and `EvidenceStore.reconcileWorm` gains the
backend-neutral name `reconcileEvidence` (the old name remains as an alias).
