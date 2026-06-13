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
} from "@pharos/core";
import type { WormStore } from "./wormStore.js";

export interface AppendInput {
  tenantId: string;
  action: ActionIntent;
  verdict: VerdictContext;
  liability: LiabilityContext;
}

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

      // Write to WORM first; a failure here aborts the whole append.
      const wormResult = await this.deps.worm.putRecord(record, this.deps.worm.retainUntil(this.now()));

      // Persist the operational copy and advance the chain head atomically.
      await client.query(
        `INSERT INTO action_records
           (tenant_id, sequence, id, content_hash, prev_hash, algorithm, key_id, signature,
            content, worm_key, worm_version_id, decision, sealed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
        ],
      );
      await client.query(
        `UPDATE tenant_chain_head SET last_sequence = $2, last_hash = $3, updated_at = now()
         WHERE tenant_id = $1`,
        [input.tenantId, sequence, record.seal.contentHash],
      );

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
      },
    };
  }

  async getRecord(tenantId: string, sequence: number): Promise<ActionRecord | null> {
    const res = await this.deps.pool.query<RecordRow>(
      `SELECT * FROM action_records WHERE tenant_id = $1 AND sequence = $2`,
      [tenantId, sequence],
    );
    return res.rows[0] ? this.rowToRecord(res.rows[0]) : null;
  }

  async getRecordById(id: string): Promise<ActionRecord | null> {
    const res = await this.deps.pool.query<RecordRow>(`SELECT * FROM action_records WHERE id = $1`, [id]);
    return res.rows[0] ? this.rowToRecord(res.rows[0]) : null;
  }

  /** Full per-tenant chain ordered by ascending sequence (genesis -> head). */
  async getChain(tenantId: string): Promise<ActionRecord[]> {
    const res = await this.deps.pool.query<RecordRow>(
      `SELECT * FROM action_records WHERE tenant_id = $1 ORDER BY sequence ASC`,
      [tenantId],
    );
    return res.rows.map((r) => this.rowToRecord(r));
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

  async count(tenantId: string): Promise<number> {
    const res = await this.deps.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM action_records WHERE tenant_id = $1`,
      [tenantId],
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
}

export type { PoolClient };
