---
"@getpharos/cli": minor
"@pharos/storage": patch
---

Introduce `@getpharos/cli` (bin `pharos`): `init`, `demo`, `log`, `verify`, `export` over the
embedded backend — a sealed, verified chain with nothing installed but Node ≥ 22.13. The CLI is
a single esbuild bundle of the workspace packages; the Postgres, Redis, S3 and KMS SDKs are
now imported lazily by their own modules so the embedded path never loads them (behaviour on
the Postgres path is unchanged; `createPool` is now async).
