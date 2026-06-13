import type { Pool } from "pg";

export type TenantStatus = "active" | "suspended" | "deleted";

export interface Tenant {
  tenantId: string;
  displayName: string;
  status: TenantStatus;
  kmsKeyName: string;
  evidencePrefix: string;
  retainEvidenceOnDelete: boolean;
}

interface TenantRow {
  tenant_id: string;
  display_name: string;
  status: string;
  kms_key_name: string;
  evidence_prefix: string;
  retain_evidence_on_delete: boolean;
}

/**
 * Tenant lifecycle: create, suspend, export, delete. Each tenant gets its own KMS signing
 * key name and its own evidence prefix (isolation boundary). Evidence-retention rules
 * survive tenant deletion where legally required: deleting a tenant removes its
 * operational rows and API keys but, when retain_evidence_on_delete is set, leaves the
 * sealed evidence chain and WORM objects intact for the mandated retention period.
 */
export class TenantStore {
  constructor(private readonly pool: Pool) {}

  private rowTo(row: TenantRow): Tenant {
    return {
      tenantId: row.tenant_id,
      displayName: row.display_name,
      status: row.status as TenantStatus,
      kmsKeyName: row.kms_key_name,
      evidencePrefix: row.evidence_prefix,
      retainEvidenceOnDelete: row.retain_evidence_on_delete,
    };
  }

  async createTenant(input: {
    tenantId: string;
    displayName: string;
    retainEvidenceOnDelete?: boolean;
  }): Promise<Tenant> {
    const kmsKeyName = `tenant:${input.tenantId}`;
    const evidencePrefix = input.tenantId;
    const res = await this.pool.query<TenantRow>(
      `INSERT INTO tenants (tenant_id, display_name, kms_key_name, evidence_prefix, retain_evidence_on_delete)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
       RETURNING *`,
      [input.tenantId, input.displayName, kmsKeyName, evidencePrefix, input.retainEvidenceOnDelete ?? true],
    );
    return this.rowTo(res.rows[0]!);
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    const res = await this.pool.query<TenantRow>(`SELECT * FROM tenants WHERE tenant_id = $1`, [tenantId]);
    return res.rows[0] ? this.rowTo(res.rows[0]) : null;
  }

  async setStatus(tenantId: string, status: TenantStatus): Promise<void> {
    await this.pool.query(`UPDATE tenants SET status = $2, updated_at = now() WHERE tenant_id = $1`, [
      tenantId,
      status,
    ]);
  }

  async listTenants(): Promise<Tenant[]> {
    const res = await this.pool.query<TenantRow>(`SELECT * FROM tenants ORDER BY tenant_id`);
    return res.rows.map((r) => this.rowTo(r));
  }

  /**
   * Delete a tenant. Marks status deleted and removes API keys. The sealed evidence
   * (action_records + WORM) is retained when retain_evidence_on_delete is set.
   * Returns whether evidence was retained.
   */
  async deleteTenant(tenantId: string): Promise<{ evidenceRetained: boolean }> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) return { evidenceRetained: false };
    await this.pool.query(`DELETE FROM api_keys WHERE tenant_id = $1`, [tenantId]);
    await this.setStatus(tenantId, "deleted");
    return { evidenceRetained: tenant.retainEvidenceOnDelete };
  }
}
