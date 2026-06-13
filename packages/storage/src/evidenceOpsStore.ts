import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface LegalHold {
  id: string;
  tenantId: string;
  name: string;
  reason: string | null;
  fromSequence: number | null;
  toSequence: number | null;
  status: "active" | "released";
}

export interface ChainAnchor {
  id: string;
  tenantId: string;
  sequence: number;
  headHash: string;
  tsaTime: string;
  tsaSignature: string;
  tsaKeyId: string;
}

export interface ClaimsPackRow {
  id: string;
  tenantId: string;
  incident: string | null;
  audience: string;
  fromSequence: number;
  toSequence: number;
  redactFields: string[];
  status: "draft" | "sealed" | "released";
  bundle: unknown | null;
  releasedTo: string | null;
}

/**
 * Operational store for the Ledger evidence operations: litigation holds, trusted-time
 * anchors, and claims packs. The evidence chain itself stays in action_records / WORM; this
 * holds the workflow state around incidents and exports.
 */
export class EvidenceOpsStore {
  constructor(private readonly pool: Pool) {}

  // --- Litigation holds ---
  async createHold(input: { tenantId: string; name: string; reason?: string; fromSequence?: number; toSequence?: number; createdBy?: string }): Promise<LegalHold> {
    const res = await this.pool.query(
      `INSERT INTO legal_holds (id, tenant_id, name, reason, from_sequence, to_sequence, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), input.tenantId, input.name, input.reason ?? null, input.fromSequence ?? null, input.toSequence ?? null, input.createdBy ?? null],
    );
    return this.holdRow(res.rows[0]);
  }

  async listHolds(tenantId: string): Promise<LegalHold[]> {
    const res = await this.pool.query(`SELECT * FROM legal_holds WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
    return res.rows.map((r) => this.holdRow(r));
  }

  async releaseHold(tenantId: string, id: string): Promise<void> {
    await this.pool.query(`UPDATE legal_holds SET status = 'released', released_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  }

  /** A sequence is under hold if any active hold's [from,to] range covers it (null = unbounded). */
  async isUnderHold(tenantId: string, sequence: number): Promise<boolean> {
    const res = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM legal_holds
       WHERE tenant_id = $1 AND status = 'active'
         AND (from_sequence IS NULL OR from_sequence <= $2)
         AND (to_sequence IS NULL OR to_sequence >= $2)`,
      [tenantId, sequence],
    );
    return Number(res.rows[0]?.n ?? 0) > 0;
  }

  private holdRow(r: Record<string, unknown>): LegalHold {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      name: r.name as string,
      reason: (r.reason as string) ?? null,
      fromSequence: r.from_sequence !== null ? Number(r.from_sequence) : null,
      toSequence: r.to_sequence !== null ? Number(r.to_sequence) : null,
      status: r.status as "active" | "released",
    };
  }

  // --- Trusted-time anchors ---
  async createAnchor(input: ChainAnchor): Promise<void> {
    await this.pool.query(
      `INSERT INTO chain_anchors (id, tenant_id, sequence, head_hash, tsa_time, tsa_signature, tsa_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.id, input.tenantId, input.sequence, input.headHash, input.tsaTime, input.tsaSignature, input.tsaKeyId],
    );
  }

  async listAnchors(tenantId: string): Promise<ChainAnchor[]> {
    const res = await this.pool.query(`SELECT * FROM chain_anchors WHERE tenant_id = $1 ORDER BY sequence ASC`, [tenantId]);
    return res.rows.map((r) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      sequence: Number(r.sequence),
      headHash: r.head_hash as string,
      tsaTime: r.tsa_time as string,
      tsaSignature: r.tsa_signature as string,
      tsaKeyId: r.tsa_key_id as string,
    }));
  }

  // --- Claims packs ---
  async createPack(input: { tenantId: string; incident?: string; audience: string; fromSequence: number; toSequence: number; redactFields?: string[] }): Promise<ClaimsPackRow> {
    const res = await this.pool.query(
      `INSERT INTO claims_packs (id, tenant_id, incident, audience, from_sequence, to_sequence, redact_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), input.tenantId, input.incident ?? null, input.audience, input.fromSequence, input.toSequence, JSON.stringify(input.redactFields ?? [])],
    );
    return this.packRow(res.rows[0]);
  }

  async sealPack(tenantId: string, id: string, bundle: unknown): Promise<ClaimsPackRow | null> {
    const res = await this.pool.query(
      `UPDATE claims_packs SET status = 'sealed', bundle = $3, sealed_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'draft' RETURNING *`,
      [tenantId, id, JSON.stringify(bundle)],
    );
    return res.rows[0] ? this.packRow(res.rows[0]) : null;
  }

  async releasePack(tenantId: string, id: string, releasedTo: string): Promise<ClaimsPackRow | null> {
    const res = await this.pool.query(
      `UPDATE claims_packs SET status = 'released', released_to = $3, released_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'sealed' RETURNING *`,
      [tenantId, id, releasedTo],
    );
    return res.rows[0] ? this.packRow(res.rows[0]) : null;
  }

  async getPack(tenantId: string, id: string): Promise<ClaimsPackRow | null> {
    const res = await this.pool.query(`SELECT * FROM claims_packs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return res.rows[0] ? this.packRow(res.rows[0]) : null;
  }

  async listPacks(tenantId: string): Promise<ClaimsPackRow[]> {
    const res = await this.pool.query(`SELECT * FROM claims_packs WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
    return res.rows.map((r) => this.packRow(r));
  }

  private packRow(r: Record<string, unknown>): ClaimsPackRow {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      incident: (r.incident as string) ?? null,
      audience: r.audience as string,
      fromSequence: Number(r.from_sequence),
      toSequence: Number(r.to_sequence),
      redactFields: (typeof r.redact_fields === "string" ? JSON.parse(r.redact_fields) : r.redact_fields ?? []) as string[],
      status: r.status as "draft" | "sealed" | "released",
      bundle: r.bundle ? (typeof r.bundle === "string" ? JSON.parse(r.bundle as string) : r.bundle) : null,
      releasedTo: (r.released_to as string) ?? null,
    };
  }
}
