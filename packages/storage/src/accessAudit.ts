import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { GENESIS_HASH, sha256Hex } from "@pharos/core";

export type AccessAction = "view" | "export" | "share" | "verify";

export interface AccessAuditEntry {
  id: string;
  tenantId: string;
  sequence: number;
  actor: string;
  actorKind: string;
  action: AccessAction;
  resource: string;
  metadata: Record<string, unknown>;
  at: string;
  prevHash: string;
  entryHash: string;
}

export interface AccessAuditVerification {
  ok: boolean;
  entriesChecked: number;
  firstBrokenSequence: number | null;
  errors: string[];
}

interface AuditRow {
  id: string;
  tenant_id: string;
  sequence: string;
  actor: string;
  actor_kind: string;
  action: string;
  resource: string;
  metadata: unknown;
  prev_hash: string;
  entry_hash: string;
  at: string;
}

/**
 * The access audit log — an evidence product whose own access is itself evidence.
 *
 * Every view, export, share, or verification of evidence is recorded as a hash-chained
 * entry, per tenant. The chain makes the audit log tamper-evident: an entry cannot be
 * altered or removed without breaking every subsequent link. This is what lets Pharos
 * answer "who saw this, and when" with the same integrity guarantees as the evidence
 * itself.
 */
export class AccessAuditLog {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  private hashEntry(e: Omit<AccessAuditEntry, "entryHash">): string {
    return sha256Hex({
      id: e.id,
      tenantId: e.tenantId,
      sequence: e.sequence,
      actor: e.actor,
      actorKind: e.actorKind,
      action: e.action,
      resource: e.resource,
      metadata: e.metadata,
      at: e.at,
      prevHash: e.prevHash,
    });
  }

  async record(input: {
    tenantId: string;
    actor: string;
    actorKind: string;
    action: AccessAction;
    resource: string;
    metadata?: Record<string, unknown>;
  }): Promise<AccessAuditEntry> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('pharos.tenant_id', $1, true)", [input.tenantId]);
      await client.query("SET LOCAL ROLE pharos_app");
      await client.query(
        `INSERT INTO access_audit_head (tenant_id, last_sequence, last_hash)
         VALUES ($1, -1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
        [input.tenantId, GENESIS_HASH],
      );
      const headRes = await client.query<{ last_sequence: string; last_hash: string }>(
        `SELECT last_sequence, last_hash FROM access_audit_head WHERE tenant_id = $1 FOR UPDATE`,
        [input.tenantId],
      );
      const head = headRes.rows[0]!;
      const sequence = Number(head.last_sequence) + 1;
      const prevHash = head.last_hash;
      const at = this.now().toISOString();
      const base: Omit<AccessAuditEntry, "entryHash"> = {
        id: randomUUID(),
        tenantId: input.tenantId,
        sequence,
        actor: input.actor,
        actorKind: input.actorKind,
        action: input.action,
        resource: input.resource,
        metadata: input.metadata ?? {},
        at,
        prevHash,
      };
      const entryHash = this.hashEntry(base);
      await client.query(
        `INSERT INTO access_audit
           (tenant_id, sequence, id, actor, actor_kind, action, resource, metadata, prev_hash, entry_hash, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          base.tenantId,
          base.sequence,
          base.id,
          base.actor,
          base.actorKind,
          base.action,
          base.resource,
          JSON.stringify(base.metadata),
          base.prevHash,
          entryHash,
          at,
        ],
      );
      await client.query(
        `UPDATE access_audit_head SET last_sequence = $2, last_hash = $3 WHERE tenant_id = $1`,
        [input.tenantId, sequence, entryHash],
      );
      await client.query("COMMIT");
      return { ...base, entryHash };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('pharos.tenant_id', $1, true)", [tenantId]);
      await client.query("SET LOCAL ROLE pharos_app");
      const r = await fn(client);
      await client.query("COMMIT");
      return r;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async list(tenantId: string): Promise<AccessAuditEntry[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<AuditRow>(
        `SELECT * FROM access_audit WHERE tenant_id = $1 ORDER BY sequence ASC`,
        [tenantId],
      );
      return res.rows.map((r) => this.rowTo(r));
    });
  }

  async verify(tenantId: string): Promise<AccessAuditVerification> {
    const entries = await this.list(tenantId);
    const out: AccessAuditVerification = { ok: true, entriesChecked: 0, firstBrokenSequence: null, errors: [] };
    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 0;
    for (const e of entries) {
      out.entriesChecked += 1;
      if (e.sequence !== expectedSeq) {
        out.ok = false;
        out.firstBrokenSequence ??= e.sequence;
        out.errors.push(`sequence gap at ${e.sequence}`);
      }
      if (e.prevHash !== expectedPrev) {
        out.ok = false;
        out.firstBrokenSequence ??= e.sequence;
        out.errors.push(`broken link at ${e.sequence}`);
      }
      const recomputed = this.hashEntry({ ...e });
      if (recomputed !== e.entryHash) {
        out.ok = false;
        out.firstBrokenSequence ??= e.sequence;
        out.errors.push(`hash mismatch at ${e.sequence}`);
      }
      expectedPrev = e.entryHash;
      expectedSeq = e.sequence + 1;
    }
    return out;
  }

  private rowTo(row: AuditRow): AccessAuditEntry {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      sequence: Number(row.sequence),
      actor: row.actor,
      actorKind: row.actor_kind,
      action: row.action as AccessAction,
      resource: row.resource,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown>),
      at: typeof row.at === "string" ? row.at : new Date(row.at).toISOString(),
      prevHash: row.prev_hash,
      entryHash: row.entry_hash,
    };
  }
}
