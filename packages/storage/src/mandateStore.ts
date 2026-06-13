import type { Pool } from "pg";
import type { MandateBinding } from "@pharos/core";

interface MandateRow {
  tenant_id: string;
  mandate_id: string;
  version: number;
  scope: string;
  limits: unknown;
  grantor: string;
  expires_at: string | null;
  status: string;
}

/**
 * Programmatic mandates. A mandate grants an agent bounded authority (scope, limits,
 * grantor, expiry). Verdicts evaluate the active mandate version as a Tier-1 input and
 * seal the exact binding into every record. New versions supersede old ones; the binding
 * embedded in a record names the version that governed that action.
 */
export class MandateStore {
  constructor(private readonly pool: Pool) {}

  private rowToBinding(row: MandateRow): MandateBinding {
    return {
      id: row.mandate_id,
      scope: row.scope,
      limits: (typeof row.limits === "string" ? JSON.parse(row.limits) : row.limits) as Record<string, unknown>,
      grantor: row.grantor,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      version: String(row.version),
    };
  }

  async create(input: {
    tenantId: string;
    mandateId: string;
    scope: string;
    limits?: Record<string, unknown>;
    grantor: string;
    expiresAt?: string | null;
  }): Promise<MandateBinding> {
    const next = await this.pool.query<{ v: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM mandates WHERE tenant_id = $1 AND mandate_id = $2`,
      [input.tenantId, input.mandateId],
    );
    const version = next.rows[0]!.v;
    const res = await this.pool.query<MandateRow>(
      `INSERT INTO mandates (tenant_id, mandate_id, version, scope, limits, grantor, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.tenantId,
        input.mandateId,
        version,
        input.scope,
        JSON.stringify(input.limits ?? {}),
        input.grantor,
        input.expiresAt ?? null,
      ],
    );
    return this.rowToBinding(res.rows[0]!);
  }

  /** Latest active version of a mandate, as a binding ready to seal into a record. */
  async getActive(tenantId: string, mandateId: string): Promise<MandateBinding | null> {
    const res = await this.pool.query<MandateRow>(
      `SELECT * FROM mandates WHERE tenant_id = $1 AND mandate_id = $2 AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
      [tenantId, mandateId],
    );
    return res.rows[0] ? this.rowToBinding(res.rows[0]) : null;
  }

  async list(tenantId: string): Promise<MandateBinding[]> {
    const res = await this.pool.query<MandateRow>(
      `SELECT DISTINCT ON (mandate_id) * FROM mandates WHERE tenant_id = $1 AND status = 'active'
       ORDER BY mandate_id, version DESC`,
      [tenantId],
    );
    return res.rows.map((r) => this.rowToBinding(r));
  }

  async revoke(tenantId: string, mandateId: string): Promise<void> {
    await this.pool.query(`UPDATE mandates SET status = 'revoked' WHERE tenant_id = $1 AND mandate_id = $2`, [
      tenantId,
      mandateId,
    ]);
  }
}
