# ActionRecord Schema v1.0.0 (frozen)

The `ActionRecord` is the universal event of the Pharos platform — one event, two
consumers. It carries the **Beam** (Decide) verdict context and the **Ledger** (Prove)
liability context in a single schema, signed once and chained once. An agent action can
never be governed without being recorded, or recorded without its governing context.

Source of truth: [`packages/core/src/schema/actionRecord.ts`](../packages/core/src/schema/actionRecord.ts).
Version constant: [`packages/core/src/schema/version.ts`](../packages/core/src/schema/version.ts).

## Layout

A record has two top-level parts:

| Part | Purpose |
|------|---------|
| `content` | The immutable evidence body — everything that is hashed and signed. |
| `seal` | The cryptographic envelope — hash-chain linkage, signature, and key id, computed *over* `content`. |

### `content`

```
content
├─ schemaVersion : "1.0.0"            literal; every record self-describes its version
├─ id            : uuid               globally unique record id
├─ tenantId      : string             isolation boundary
├─ sequence      : int ≥ 0            per-tenant monotonic; 0 is genesis
├─ action        : ActionIntent       what the agent is trying to do
├─ verdict       : VerdictContext      Beam / Decide
├─ liability     : LiabilityContext    Ledger / Prove
└─ sealedAt      : ISO-8601           when content was sealed
```

**`ActionIntent`** — `type`, `agentId`, `sessionId?`, `payload`, `emittedAt`.

**`VerdictContext`** (Beam): `decision` (`allow|block|modify|escalate`), `tierReached`
(`1|2|3|"human"`), `ruleCitations[]` (each naming `ruleId`, `pack`, `clause`,
`description`), `riskScore` (0–1), `failMode` (`fail_open|fail_closed|null`),
`judgeVersion`, `latency` (`totalMs`, `perTier`, `deadlineMs`, `deadlineBreached`).

**`LiabilityContext`** (Ledger): `mandate` (id, scope, limits, grantor, expiry,
version), `oversightMode` (`autonomous|human_in_loop|human_on_loop`), `blastRadius`
(financial amount, currency, reversibility), `modelMetadata` (provider, model, version).

### `seal`

```
seal
├─ contentHash : sha256 hex of canonical(content)
├─ prevHash    : contentHash of the previous record (GENESIS_HASH = 64 zeros at seq 0)
├─ algorithm   : "ed25519"
├─ keyId       : KMS key id that signed it (enables rotation with chain continuity)
└─ signature   : base64 Ed25519 signature over the contentHash bytes
```

## Versioning rules

- **PATCH** — additive optional field, no migration.
- **MINOR** — additive required field with a default migration.
- **MAJOR** — breaking change; requires a forward migration adapter and a documented
  re-verification procedure for the chain.

The version is frozen at `1.0.0` as of Sprint 0. Migration adapters translate the two
legacy shapes (AI Lighthouse verdict records, Flightline liability events) into v1 and
back: [`packages/core/src/migration/`](../packages/core/src/migration/).

## Canonicalization

Hashing and signing operate on a deterministic serialization (sorted object keys, no
insignificant whitespace, arrays preserve order, `undefined` dropped). This is
intentionally simple and dependency-free so a third party can reimplement it — see
[`canonical.ts`](../packages/core/src/chain/canonical.ts) and
[external verification](./external-verification.md).
