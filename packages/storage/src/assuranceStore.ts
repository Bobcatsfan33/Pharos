import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface AssuranceAudit {
  id: string;
  tenantId: string;
  recordSequence: number;
  pack: string | null;
  machineDecision: string | null;
  upheld: boolean | null;
  status: "pending" | "audited";
}

export interface AssuranceStats {
  total: number;
  upheld: number;
}

/**
 * Assurance store: sample verdicts into a human audit queue, record whether the human upheld
 * the machine decision, and aggregate the upheld counts that feed the Wilson-score bound.
 */
export class AssuranceStore {
  constructor(private readonly pool: Pool) {}

  /** Enqueue audits for candidate verdicts not yet sampled. Returns how many were added. */
  async sample(
    tenantId: string,
    candidates: Array<{ recordSequence: number; pack: string | null; decision: string }>,
  ): Promise<number> {
    let added = 0;
    for (const c of candidates) {
      const res = await this.pool.query(
        `INSERT INTO assurance_audits (id, tenant_id, record_sequence, pack, machine_decision)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, record_sequence) DO NOTHING`,
        [randomUUID(), tenantId, c.recordSequence, c.pack, c.decision],
      );
      if (res.rowCount && res.rowCount > 0) added += 1;
    }
    return added;
  }

  async listPending(tenantId: string, limit = 100): Promise<AssuranceAudit[]> {
    const res = await this.pool.query(
      `SELECT * FROM assurance_audits WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT $2`,
      [tenantId, limit],
    );
    return res.rows.map((r) => this.row(r));
  }

  async recordAudit(
    tenantId: string,
    id: string,
    upheld: boolean,
    auditedBy: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE assurance_audits SET upheld = $3, status = 'audited', audited_by = $4, audited_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, upheld, auditedBy],
    );
  }

  /** Upheld counts over audited samples, optionally filtered by pack. */
  async stats(tenantId: string, pack?: string): Promise<AssuranceStats> {
    const params: unknown[] = [tenantId];
    let where = `tenant_id = $1 AND status = 'audited'`;
    if (pack) {
      params.push(pack);
      where += ` AND pack = $2`;
    }
    const res = await this.pool.query<{ total: string; upheld: string }>(
      `SELECT count(*)::text AS total, count(*) FILTER (WHERE upheld)::text AS upheld FROM assurance_audits WHERE ${where}`,
      params,
    );
    return { total: Number(res.rows[0]?.total ?? 0), upheld: Number(res.rows[0]?.upheld ?? 0) };
  }

  async statsByPack(tenantId: string): Promise<Record<string, AssuranceStats>> {
    const res = await this.pool.query<{ pack: string; total: string; upheld: string }>(
      `SELECT COALESCE(pack,'core') AS pack, count(*)::text AS total, count(*) FILTER (WHERE upheld)::text AS upheld
       FROM assurance_audits WHERE tenant_id = $1 AND status = 'audited' GROUP BY pack`,
      [tenantId],
    );
    const out: Record<string, AssuranceStats> = {};
    for (const r of res.rows) out[r.pack] = { total: Number(r.total), upheld: Number(r.upheld) };
    return out;
  }

  // --- Readiness-gate exceptions ---
  async grantException(
    tenantId: string,
    checkId: string,
    owner: string,
    reason?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO readiness_exceptions (tenant_id, check_id, owner, reason) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, check_id) DO UPDATE SET owner = EXCLUDED.owner, reason = EXCLUDED.reason`,
      [tenantId, checkId, owner, reason ?? null],
    );
  }

  async revokeException(tenantId: string, checkId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM readiness_exceptions WHERE tenant_id = $1 AND check_id = $2`,
      [tenantId, checkId],
    );
  }

  async exceptions(tenantId: string): Promise<Record<string, string>> {
    const res = await this.pool.query<{ check_id: string; owner: string }>(
      `SELECT check_id, owner FROM readiness_exceptions WHERE tenant_id = $1`,
      [tenantId],
    );
    const out: Record<string, string> = {};
    for (const r of res.rows) out[r.check_id] = r.owner;
    return out;
  }

  private row(r: Record<string, unknown>): AssuranceAudit {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      recordSequence: Number(r.record_sequence),
      pack: (r.pack as string) ?? null,
      machineDecision: (r.machine_decision as string) ?? null,
      upheld: (r.upheld as boolean) ?? null,
      status: r.status as "pending" | "audited",
    };
  }
}
