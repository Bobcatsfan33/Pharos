import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type PolicyStatus = "draft" | "shadow" | "active" | "rolled_back" | "archived";

export interface PolicyVersion {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  status: PolicyStatus;
  artifact: unknown;
  sourceText: string | null;
  changelog: string | null;
}

/**
 * Per-tenant policy lifecycle store. A policy name has many versions; at most one is active
 * at a time. Activation archives the previously-active version; rollback reactivates the
 * prior version — a single status flip that restores prior state in well under a minute with
 * zero evidence-chain disruption (verdicts reference policies; the chain is untouched).
 */
export class PolicyStore {
  constructor(private readonly pool: Pool) {}

  private row(r: Record<string, unknown>): PolicyVersion {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      name: r.name as string,
      version: Number(r.version),
      status: r.status as PolicyStatus,
      artifact: typeof r.artifact === "string" ? JSON.parse(r.artifact as string) : r.artifact,
      sourceText: (r.source_text as string) ?? null,
      changelog: (r.changelog as string) ?? null,
    };
  }

  async createDraft(input: { tenantId: string; name: string; artifact: unknown; sourceText?: string; changelog?: string }): Promise<PolicyVersion> {
    const next = await this.pool.query<{ v: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM policies WHERE tenant_id = $1 AND name = $2`,
      [input.tenantId, input.name],
    );
    const res = await this.pool.query(
      `INSERT INTO policies (id, tenant_id, name, version, artifact, source_text, changelog)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), input.tenantId, input.name, next.rows[0]!.v, JSON.stringify(input.artifact), input.sourceText ?? null, input.changelog ?? null],
    );
    return this.row(res.rows[0]);
  }

  async get(tenantId: string, id: string): Promise<PolicyVersion | null> {
    const res = await this.pool.query(`SELECT * FROM policies WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return res.rows[0] ? this.row(res.rows[0]) : null;
  }

  async list(tenantId: string): Promise<PolicyVersion[]> {
    const res = await this.pool.query(`SELECT * FROM policies WHERE tenant_id = $1 ORDER BY name, version DESC`, [tenantId]);
    return res.rows.map((r) => this.row(r));
  }

  async setStatus(tenantId: string, id: string, status: PolicyStatus): Promise<PolicyVersion | null> {
    const res = await this.pool.query(`UPDATE policies SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, id, status]);
    return res.rows[0] ? this.row(res.rows[0]) : null;
  }

  /** Promote a version to active, archiving any previously-active version of the same name. */
  async activate(tenantId: string, id: string): Promise<PolicyVersion | null> {
    const policy = await this.get(tenantId, id);
    if (!policy) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE policies SET status = 'archived' WHERE tenant_id = $1 AND name = $2 AND status = 'active'`, [tenantId, policy.name]);
      const res = await client.query(`UPDATE policies SET status = 'active', activated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, id]);
      await client.query("COMMIT");
      return res.rows[0] ? this.row(res.rows[0]) : null;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Roll back: the current active version becomes rolled_back; the prior version reactivates. */
  async rollback(tenantId: string, name: string): Promise<{ rolledBack: PolicyVersion | null; restored: PolicyVersion | null }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(`SELECT * FROM policies WHERE tenant_id = $1 AND name = $2 AND status = 'active' LIMIT 1`, [tenantId, name]);
      const current = cur.rows[0] ? this.row(cur.rows[0]) : null;
      let restored: PolicyVersion | null = null;
      if (current) {
        await client.query(`UPDATE policies SET status = 'rolled_back' WHERE tenant_id = $1 AND id = $2`, [tenantId, current.id]);
        const prior = await client.query(
          `SELECT * FROM policies WHERE tenant_id = $1 AND name = $2 AND version < $3 AND status = 'archived'
           ORDER BY version DESC LIMIT 1`,
          [tenantId, name, current.version],
        );
        if (prior.rows[0]) {
          const r = await client.query(`UPDATE policies SET status = 'active', activated_at = now() WHERE id = $1 RETURNING *`, [prior.rows[0].id]);
          restored = this.row(r.rows[0]);
        }
      }
      await client.query("COMMIT");
      return { rolledBack: current, restored };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Active policy artifacts for a tenant (to fold into the cascade alongside shipped packs). */
  async getActiveArtifacts(tenantId: string): Promise<unknown[]> {
    const res = await this.pool.query(`SELECT artifact FROM policies WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
    return res.rows.map((r) => (typeof r.artifact === "string" ? JSON.parse(r.artifact) : r.artifact));
  }

  async getShadowArtifacts(tenantId: string): Promise<unknown[]> {
    const res = await this.pool.query(`SELECT artifact FROM policies WHERE tenant_id = $1 AND status = 'shadow'`, [tenantId]);
    return res.rows.map((r) => (typeof r.artifact === "string" ? JSON.parse(r.artifact) : r.artifact));
  }
}
