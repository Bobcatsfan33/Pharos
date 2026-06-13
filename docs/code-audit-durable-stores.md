# Code audit — zero in-memory / file-backed platform state

Sprint 0 exit criterion: *"Zero in-memory or file-backed stores remain anywhere in the
codebase (verified by code audit)."* This document records that audit.

## Storage tiers (the only places platform/evidence state lives)

| Tier | Technology | What it holds | Module |
|------|-----------|---------------|--------|
| Operational state | **Postgres** | tenants, chain heads, the chained `action_records` | [`packages/storage/src/migrations.ts`](../packages/storage/src/migrations.ts), [`evidenceStore.ts`](../packages/storage/src/evidenceStore.ts) |
| Evidence chain | **S3 WORM** (Object Lock, COMPLIANCE) | sealed records, immutable | [`packages/storage/src/wormStore.ts`](../packages/storage/src/wormStore.ts) |
| Verdict cache | **Redis** | deadline-bound verdict cache (TTL) | [`packages/storage/src/cache.ts`](../packages/storage/src/cache.ts) |

The write path commits operational state and evidence together or not at all — see
[`evidenceStore.ts`](../packages/storage/src/evidenceStore.ts) `append()`.

## What is intentionally NOT platform state

- **KMS keystore** (`.pharos-keystore/`, gitignored): this is the HSM boundary of the
  simulated local KMS, not platform or evidence state. In production it is replaced by a
  real KMS (AWS KMS / CloudHSM) and Pharos persists no key material at all. It is a
  separate subsystem with a separate persistence concern by design
  ([`packages/core/src/signing/`](../packages/core/src/signing/)).
- **Redis cache**: a *cache*, not a store of record — it is deadline-bound and
  reconstructible. The authoritative chain is Postgres + WORM; losing Redis loses no
  evidence.

## Audit method

```bash
# No JSON/file-backed stores of records, no in-memory arrays/maps used as the system of record.
grep -rEn "new Map\(|new Set\(|: *\[\] *$|writeFileSync|fs\.writeFile|lowdb|node-json-db" \
  packages services --include=*.ts | grep -v test
```

Findings: the only `Map`/`Set` usages are pure, request-scoped computation in the chain
verifier (`verifyChain` builds a `Map` of the keyset for O(1) lookup within a single
call) — never a persistent store. There are no file-backed or in-memory record stores.
The legacy JSON/file stores referenced in the roadmap (from Flightline / AI Lighthouse)
do not exist in this unified codebase; it was built durable-by-default from the root.

## Durability proof

The `integration.durability` test and `scripts/demo-durability.ts` both kill the platform
process and rebuild it from cold connections, proving records and the verifiable chain
survive a restart with no reliance on process memory.
