import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  type ActionRecord,
  type ActionIntent,
  type VerdictContext,
  type LiabilityContext,
  type SigningProvider,
  ACTION_RECORD_SCHEMA_VERSION,
  GENESIS_HASH,
  sealRecord,
  computeDisclosures,
  disclosureBindingMessage,
} from "@pharos/core";
import type { WormStore } from "./wormStore.js";

export interface AppendInput {
  tenantId: string;
  action: ActionIntent;
  verdict: VerdictContext;
  liability: LiabilityContext;
  /**
   * Optional replay guard (#74). When present, the append and the claim on the key
   * commit together, so a redelivery of the same request cannot seal a second record.
   */
  idempotency?: IdempotencyClaim;
}

export interface IdempotencyClaim {
  /** Client-supplied key, unique per tenant. */
  key: string;
  /** SHA-256 over the canonicalized submission; binds the key to one exact request. */
  requestFingerprint: string;
}

/**
 * The key exists but was claimed by a *different* request. Never resolved by
 * returning the earlier record: the caller asked for something else, and answering
 * with an unrelated sealed record would misreport what was governed.
 */
export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(`idempotency key already used for a different request`);
    this.name = "IdempotencyConflictError";
  }
}

/** A concurrent delivery won the race for this key; the caller should re-read and replay. */
export class IdempotencyReplayError extends Error {
  constructor(readonly key: string) {
    super(`idempotency key was claimed concurrently`);
    this.name = "IdempotencyReplayError";
  }
}

/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = "23505";

export interface EvidenceStoreDeps {
  pool: Pool;
  worm: WormStore;
  signer: SigningProvider;
  /** Resolve the KMS key name for a tenant. Sprint 0: per-environment; Sprint 1: per-tenant. */
  resolveKeyName: (tenantId: string) => string;
  now?: () => Date;
}

/**
 * The transactional write path.
 *
 * append() allocates the next per-tenant sequence under a row lock, seals the record
 * (hash + signature linking it to the prior head), writes it to WORM, then commits
 * the Postgres row and advances the chain head — all in one transaction. If the WORM
 * write fails the transaction rolls back and no verdict is recorded; verdict and
 * evidence commit together or not at all. A WORM object orphaned by a post-PUT commit
 * failure is harmless: it is content-addressed and detected by reconcile().
 */
export class EvidenceStore {
  constructor(private readonly deps: EvidenceStoreDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async append(input: AppendInput): Promise<ActionRecord> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      // Bind the RLS tenant context and drop to the NOBYPASSRLS app role so the
      // row-level security policy actually confines the action_records write.
      await client.query("SELECT set_config('pharos.tenant_id', $1, true)", [input.tenantId]);
      await client.query("SET LOCAL ROLE pharos_app");

      // Ensure a head row exists, then lock it to serialize this tenant's appends.
      await client.query(
        `INSERT INTO tenant_chain_head (tenant_id, last_sequence, last_hash)
         VALUES ($1, -1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
        [input.tenantId, GENESIS_HASH],
      );
      const headRes = await client.query<{ last_sequence: string; last_hash: string }>(
        `SELECT last_sequence, last_hash FROM tenant_chain_head WHERE tenant_id = $1 FOR UPDATE`,
        [input.tenantId],
      );
      const head = headRes.rows[0]!;
      const sequence = Number(head.last_sequence) + 1;
      const prevHash = head.last_hash;

      // Build and seal the record.
      const sealedAt = this.now().toISOString();
      const keyName = this.deps.resolveKeyName(input.tenantId);
      const keyId = await this.deps.signer.ensureKey(keyName);
      const record = await sealRecord({
        content: {
          schemaVersion: ACTION_RECORD_SCHEMA_VERSION,
          id: randomUUID(),
          tenantId: input.tenantId,
          sequence,
          action: input.action,
          verdict: input.verdict,
          liability: input.liability,
          sealedAt,
        },
        prevHash,
        signer: this.deps.signer,
        keyId,
      });

      // Selective-disclosure commitments over the payload, signed and bound to this
      // record's contentHash so a redacted view cannot be lifted onto another record.
      const disclosures = computeDisclosures(record.content.action.payload);
      const disclosureSig = await this.deps.signer.sign(
        keyId,
        disclosureBindingMessage(disclosures.disclosureRoot, record.seal.contentHash),
      );

      // Write to WORM first; a failure here aborts the whole append.
      const wormResult = await this.deps.worm.putRecord(
        record,
        this.deps.worm.retainUntil(this.now()),
      );

      // Persist the operational copy and advance the chain head atomically.
      await client.query(
        `INSERT INTO action_records
           (tenant_id, sequence, id, content_hash, prev_hash, algorithm, key_id, signature,
            content, worm_key, worm_version_id, decision, sealed_at,
            disclosure_root, disclosure_sig, salts, commitments, sig_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          input.tenantId,
          sequence,
          record.content.id,
          record.seal.contentHash,
          record.seal.prevHash,
          record.seal.algorithm,
          record.seal.keyId,
          record.seal.signature,
          JSON.stringify(record.content),
          wormResult.key,
          wormResult.versionId ?? null,
          record.content.verdict.decision,
          sealedAt,
          disclosures.disclosureRoot,
          disclosureSig,
          JSON.stringify(disclosures.salts),
          JSON.stringify(disclosures.commitments),
          record.seal.sigVersion ?? null,
        ],
      );
      await client.query(
        `UPDATE tenant_chain_head SET last_sequence = $2, last_hash = $3, updated_at = now()
         WHERE tenant_id = $1`,
        [input.tenantId, sequence, record.seal.contentHash],
      );

      // Claim the idempotency key in THIS transaction. Committing the claim together
      // with the record is what makes the guard exact: there is no window in which a
      // record exists without its claim (a replay would seal a second record) or a
      // claim exists without its record (a replay would resolve to nothing).
      //
      // The primary key is the arbiter. Concurrent deliveries already serialize on the
      // tenant_chain_head row lock taken above, so the loser reaches this INSERT after
      // the winner has committed and takes the unique violation.
      if (input.idempotency) {
        try {
          await client.query(
            `INSERT INTO ingest_idempotency (tenant_id, idempotency_key, request_fingerprint, sequence)
             VALUES ($1,$2,$3,$4)`,
            [input.tenantId, input.idempotency.key, input.idempotency.requestFingerprint, sequence],
          );
        } catch (err) {
          if ((err as { code?: string }).code !== PG_UNIQUE_VIOLATION) throw err;
          // Someone else claimed the key. The enclosing catch rolls this append back
          // entirely — no record is sealed — and the caller re-reads and answers with
          // the winner's record.
          throw new IdempotencyReplayError(input.idempotency.key);
        }
      }

      await client.query("COMMIT");
      return record;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private rowToRecord(row: RecordRow): ActionRecord {
    return {
      content: typeof row.content === "string" ? JSON.parse(row.content) : row.content,
      seal: {
        contentHash: row.content_hash,
        prevHash: row.prev_hash,
        algorithm: row.algorithm as "ed25519",
        keyId: row.key_id,
        signature: row.signature,
        // NULL column = legacy v1 seal (sigVersion absent).
        ...(row.sig_version != null ? { sigVersion: row.sig_version as 1 | 2 } : {}),
      },
    };
  }

  /**
   * Run reads inside a transaction that binds the RLS tenant context. The row-level
   * security policy on action_records then confines every query to this tenant — a
   * defense-in-depth backstop beneath the application-layer authorization checks.
   */
  private async withTenant<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('pharos.tenant_id', $1, true)", [tenantId]);
      await client.query("SET LOCAL ROLE pharos_app");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getRecord(tenantId: string, sequence: number): Promise<ActionRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<RecordRow>(
        `SELECT * FROM action_records WHERE tenant_id = $1 AND sequence = $2`,
        [tenantId, sequence],
      );
      return res.rows[0] ? this.rowToRecord(res.rows[0]) : null;
    });
  }

  /**
   * Resolve a previously-claimed idempotency key (#74).
   *
   * Returns the sealed record the key produced, or null if the key is unused. Throws
   * IdempotencyConflictError when the key was claimed by a materially different
   * request — re-using a key against a new action is refused, not collapsed, so a
   * caller cannot point an old approval at a new action.
   */
  async findByIdempotencyKey(
    tenantId: string,
    key: string,
    requestFingerprint: string,
  ): Promise<ActionRecord | null> {
    const claim = await this.withTenant(tenantId, async (client) => {
      const res = await client.query<{ sequence: string; request_fingerprint: string }>(
        `SELECT sequence, request_fingerprint FROM ingest_idempotency
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, key],
      );
      return res.rows[0] ?? null;
    });
    if (!claim) return null;
    if (claim.request_fingerprint !== requestFingerprint) {
      throw new IdempotencyConflictError(key);
    }
    const record = await this.getRecord(tenantId, Number(claim.sequence));
    if (!record) {
      // The claim and the record commit in one transaction, so this is unreachable
      // short of out-of-band deletion. Fail loudly rather than silently re-appending.
      throw new Error(`idempotency claim ${key} references missing record ${claim.sequence}`);
    }
    return record;
  }

  async getRecordById(tenantId: string, id: string): Promise<ActionRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<RecordRow>(
        `SELECT * FROM action_records WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return res.rows[0] ? this.rowToRecord(res.rows[0]) : null;
    });
  }

  /** Full per-tenant chain ordered by ascending sequence (genesis -> head). */
  async getChain(tenantId: string): Promise<ActionRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<RecordRow>(
        `SELECT * FROM action_records WHERE tenant_id = $1 ORDER BY sequence ASC`,
        [tenantId],
      );
      return res.rows.map((r) => this.rowToRecord(r));
    });
  }

  /** Records in a sequence range with their selective-disclosure data (for claims packs). */
  async getRange(
    tenantId: string,
    fromSequence: number,
    toSequence: number,
  ): Promise<RecordDisclosure[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<RecordRow>(
        `SELECT * FROM action_records WHERE tenant_id = $1 AND sequence >= $2 AND sequence <= $3 ORDER BY sequence ASC`,
        [tenantId, fromSequence, toSequence],
      );
      return res.rows.map((r) => ({
        record: this.rowToRecord(r),
        disclosureRoot: r.disclosure_root ?? "",
        disclosureSignature: r.disclosure_sig ?? "",
        salts: (typeof r.salts === "string" ? JSON.parse(r.salts) : (r.salts ?? {})) as Record<
          string,
          string
        >,
        commitments: (typeof r.commitments === "string"
          ? JSON.parse(r.commitments)
          : (r.commitments ?? {})) as Record<string, string>,
        keyId: r.key_id,
      }));
    });
  }

  async getHead(tenantId: string): Promise<{ sequence: number; hash: string } | null> {
    const res = await this.deps.pool.query<{ last_sequence: string; last_hash: string }>(
      `SELECT last_sequence, last_hash FROM tenant_chain_head WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = res.rows[0];
    if (!row || Number(row.last_sequence) < 0) return null;
    return { sequence: Number(row.last_sequence), hash: row.last_hash };
  }

  async listTenants(): Promise<string[]> {
    const res = await this.deps.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_chain_head ORDER BY tenant_id`,
    );
    return res.rows.map((r) => r.tenant_id);
  }

  /** Count recorded actions in an optional [from, to) window — the metered billing quantity. */
  async countInPeriod(tenantId: string, fromIso?: string, toIso?: string): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const conds = ["tenant_id = $1"];
      const params: unknown[] = [tenantId];
      if (fromIso) {
        params.push(fromIso);
        conds.push(`created_at >= $${params.length}`);
      }
      if (toIso) {
        params.push(toIso);
        conds.push(`created_at < $${params.length}`);
      }
      const res = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM action_records WHERE ${conds.join(" AND ")}`,
        params,
      );
      return Number(res.rows[0]?.n ?? 0);
    });
  }

  async count(tenantId: string): Promise<number> {
    const res = await this.withTenant(tenantId, (client) =>
      client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM action_records WHERE tenant_id = $1`,
        [tenantId],
      ),
    );
    return Number(res.rows[0]?.n ?? 0);
  }
}

interface RecordRow {
  tenant_id: string;
  sequence: string;
  id: string;
  content_hash: string;
  prev_hash: string;
  algorithm: string;
  key_id: string;
  signature: string;
  content: unknown;
  worm_key: string | null;
  worm_version_id: string | null;
  decision: string;
  sealed_at: string;
  sig_version: number | null;
  disclosure_root: string | null;
  disclosure_sig: string | null;
  salts: unknown;
  commitments: unknown;
}

export interface RecordDisclosure {
  record: ActionRecord;
  disclosureRoot: string;
  disclosureSignature: string;
  salts: Record<string, string>;
  commitments: Record<string, string>;
  keyId: string;
}

export type { PoolClient };
