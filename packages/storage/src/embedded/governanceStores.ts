import { randomUUID } from "node:crypto";
import type { MandateBinding } from "@pharos/core";
import type { AssuranceAudit, AssuranceStats } from "../assuranceStore.js";
import type { ChainAnchor, ClaimsPackRow, LegalHold } from "../evidenceOpsStore.js";
import type { PolicyStatus, PolicyVersion } from "../policyStore.js";
import type {
  AssuranceStorePort,
  EvidenceOpsStorePort,
  MandateStorePort,
  PolicyStorePort,
} from "../ports.js";
import { EmbeddedDb, nowIso, parseJson } from "./sqlite.js";

/** SQLite has no boolean type; the schema stores INTEGER 0/1. */
export function toBool(v: unknown): boolean {
  return Boolean(Number(v));
}

/** Normalise a caller-supplied timestamp the way Postgres `timestamptz` round-trips it. */
export function isoOrNull(v: string | null | undefined): string | null {
  return v ? new Date(v).toISOString() : null;
}

export function iso(v: string): string {
  return typeof v === "string" && v.includes("T") ? v : new Date(v).toISOString();
}

// ---------------------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------------------

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

/** Embedded programmatic mandates; see `MandateStore` for the lifecycle semantics. */
export class EmbeddedMandateStore implements MandateStorePort {
  constructor(private readonly db: EmbeddedDb) {}

  private rowToBinding(row: MandateRow): MandateBinding {
    return {
      id: row.mandate_id,
      scope: row.scope,
      limits: parseJson(row.limits) as Record<string, unknown>,
      grantor: row.grantor,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      version: String(row.version),
    };
  }

  create(input: {
    tenantId: string;
    mandateId: string;
    scope: string;
    limits?: Record<string, unknown>;
    grantor: string;
    expiresAt?: string | null;
  }): Promise<MandateBinding> {
    return this.db.transaction(() => {
      const next = this.db.get<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM mandates WHERE tenant_id = ? AND mandate_id = ?`,
        input.tenantId,
        input.mandateId,
      )!;
      const row = this.db.get<MandateRow>(
        `INSERT INTO mandates (tenant_id, mandate_id, version, scope, limits, grantor, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
        input.tenantId,
        input.mandateId,
        Number(next.v),
        input.scope,
        JSON.stringify(input.limits ?? {}),
        input.grantor,
        isoOrNull(input.expiresAt),
        nowIso(),
      );
      return this.rowToBinding(row!);
    });
  }

  /** Latest active version of a mandate, as a binding ready to seal into a record. */
  getActive(tenantId: string, mandateId: string): Promise<MandateBinding | null> {
    return this.db.exclusive(() => {
      const row = this.db.get<MandateRow>(
        `SELECT * FROM mandates WHERE tenant_id = ? AND mandate_id = ? AND status = 'active'
         ORDER BY version DESC LIMIT 1`,
        tenantId,
        mandateId,
      );
      return row ? this.rowToBinding(row) : null;
    });
  }

  list(tenantId: string): Promise<MandateBinding[]> {
    return this.db.exclusive(() =>
      this.db
        .all<MandateRow>(
          `SELECT * FROM mandates WHERE tenant_id = ? AND status = 'active'
             AND version = (SELECT max(version) FROM mandates m2
                            WHERE m2.tenant_id = mandates.tenant_id
                              AND m2.mandate_id = mandates.mandate_id AND m2.status = 'active')
           ORDER BY mandate_id`,
          tenantId,
        )
        .map((r) => this.rowToBinding(r)),
    );
  }

  revoke(tenantId: string, mandateId: string): Promise<void> {
    return this.db.exclusive(() => {
      this.db.run(
        `UPDATE mandates SET status = 'revoked' WHERE tenant_id = ? AND mandate_id = ?`,
        tenantId,
        mandateId,
      );
    });
  }
}

// ---------------------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------------------

export class EmbeddedEvidenceOpsStore implements EvidenceOpsStorePort {
  constructor(private readonly db: EmbeddedDb) {}

  // --- Litigation holds ---
  createHold(input: {
    tenantId: string;
    name: string;
    reason?: string;
    fromSequence?: number;
    toSequence?: number;
    createdBy?: string;
  }): Promise<LegalHold> {
    return this.db.exclusive(() => {
      const row = this.db.get(
        `INSERT INTO legal_holds (id, tenant_id, name, reason, from_sequence, to_sequence, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
        randomUUID(),
        input.tenantId,
        input.name,
        input.reason ?? null,
        input.fromSequence ?? null,
        input.toSequence ?? null,
        input.createdBy ?? null,
        nowIso(),
      );
      return this.holdRow(row!);
    });
  }

  listHolds(tenantId: string): Promise<LegalHold[]> {
    return this.db.exclusive(() =>
      this.db
        .all(
          `SELECT * FROM legal_holds WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC`,
          tenantId,
        )
        .map((r) => this.holdRow(r)),
    );
  }

  releaseHold(tenantId: string, id: string): Promise<void> {
    return this.db.exclusive(() => {
      this.db.run(
        `UPDATE legal_holds SET status = 'released', released_at = ? WHERE tenant_id = ? AND id = ?`,
        nowIso(),
        tenantId,
        id,
      );
    });
  }

  /** A sequence is under hold if any active hold's [from,to] range covers it (null = unbounded). */
  isUnderHold(tenantId: string, sequence: number): Promise<boolean> {
    return this.db.exclusive(() => {
      const row = this.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM legal_holds
         WHERE tenant_id = ? AND status = 'active'
           AND (from_sequence IS NULL OR from_sequence <= ?)
           AND (to_sequence IS NULL OR to_sequence >= ?)`,
        tenantId,
        sequence,
        sequence,
      );
      return Number(row?.n ?? 0) > 0;
    });
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
  createAnchor(input: ChainAnchor): Promise<void> {
    return this.db.exclusive(() => {
      this.db.run(
        `INSERT INTO chain_anchors
           (id, tenant_id, sequence, head_hash, tsa_provider, tsa_time, tsa_signature, tsa_key_id, tsa_token, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        input.id,
        input.tenantId,
        input.sequence,
        input.headHash,
        input.provider,
        input.tsaTime,
        input.tsaSignature,
        input.tsaKeyId,
        input.tsaToken,
        nowIso(),
      );
    });
  }

  listAnchors(tenantId: string): Promise<ChainAnchor[]> {
    return this.db.exclusive(() =>
      this.db
        .all(`SELECT * FROM chain_anchors WHERE tenant_id = ? ORDER BY sequence ASC`, tenantId)
        .map((r) => ({
          id: r.id as string,
          tenantId: r.tenant_id as string,
          sequence: Number(r.sequence),
          headHash: r.head_hash as string,
          provider: ((r.tsa_provider as string) ?? "local") as "local" | "rfc3161",
          tsaTime: r.tsa_time as string,
          tsaSignature: (r.tsa_signature as string) ?? null,
          tsaKeyId: (r.tsa_key_id as string) ?? null,
          tsaToken: (r.tsa_token as string) ?? null,
        })),
    );
  }

  // --- Claims packs ---
  createPack(input: {
    tenantId: string;
    incident?: string;
    audience: string;
    fromSequence: number;
    toSequence: number;
    redactFields?: string[];
  }): Promise<ClaimsPackRow> {
    return this.db.exclusive(() => {
      const row = this.db.get(
        `INSERT INTO claims_packs (id, tenant_id, incident, audience, from_sequence, to_sequence, redact_fields, created_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
        randomUUID(),
        input.tenantId,
        input.incident ?? null,
        input.audience,
        input.fromSequence,
        input.toSequence,
        JSON.stringify(input.redactFields ?? []),
        nowIso(),
      );
      return this.packRow(row!);
    });
  }

  sealPack(tenantId: string, id: string, bundle: unknown): Promise<ClaimsPackRow | null> {
    return this.db.exclusive(() => {
      const row = this.db.get(
        `UPDATE claims_packs SET status = 'sealed', bundle = ?, sealed_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'draft' RETURNING *`,
        JSON.stringify(bundle),
        nowIso(),
        tenantId,
        id,
      );
      return row ? this.packRow(row) : null;
    });
  }

  releasePack(tenantId: string, id: string, releasedTo: string): Promise<ClaimsPackRow | null> {
    return this.db.exclusive(() => {
      const row = this.db.get(
        `UPDATE claims_packs SET status = 'released', released_to = ?, released_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'sealed' RETURNING *`,
        releasedTo,
        nowIso(),
        tenantId,
        id,
      );
      return row ? this.packRow(row) : null;
    });
  }

  getPack(tenantId: string, id: string): Promise<ClaimsPackRow | null> {
    return this.db.exclusive(() => {
      const row = this.db.get(
        `SELECT * FROM claims_packs WHERE tenant_id = ? AND id = ?`,
        tenantId,
        id,
      );
      return row ? this.packRow(row) : null;
    });
  }

  listPacks(tenantId: string): Promise<ClaimsPackRow[]> {
    return this.db.exclusive(() =>
      this.db
        .all(
          `SELECT * FROM claims_packs WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC`,
          tenantId,
        )
        .map((r) => this.packRow(r)),
    );
  }

  private packRow(r: Record<string, unknown>): ClaimsPackRow {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      incident: (r.incident as string) ?? null,
      audience: r.audience as string,
      fromSequence: Number(r.from_sequence),
      toSequence: Number(r.to_sequence),
      redactFields: (parseJson(r.redact_fields) ?? []) as string[],
      status: r.status as "draft" | "sealed" | "released",
      bundle: r.bundle ? parseJson(r.bundle) : null,
      releasedTo: (r.released_to as string) ?? null,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------------------

/** Embedded per-tenant policy lifecycle; see `PolicyStore` for activate/rollback semantics. */
export class EmbeddedPolicyStore implements PolicyStorePort {
  constructor(private readonly db: EmbeddedDb) {}

  private row(r: Record<string, unknown>): PolicyVersion {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      name: r.name as string,
      version: Number(r.version),
      status: r.status as PolicyStatus,
      artifact: parseJson(r.artifact),
      sourceText: (r.source_text as string) ?? null,
      changelog: (r.changelog as string) ?? null,
    };
  }

  createDraft(input: {
    tenantId: string;
    name: string;
    artifact: unknown;
    sourceText?: string;
    changelog?: string;
  }): Promise<PolicyVersion> {
    return this.db.transaction(() => {
      const next = this.db.get<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM policies WHERE tenant_id = ? AND name = ?`,
        input.tenantId,
        input.name,
      )!;
      const row = this.db.get(
        `INSERT INTO policies (id, tenant_id, name, version, artifact, source_text, changelog, created_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
        randomUUID(),
        input.tenantId,
        input.name,
        Number(next.v),
        JSON.stringify(input.artifact),
        input.sourceText ?? null,
        input.changelog ?? null,
        nowIso(),
      );
      return this.row(row!);
    });
  }

  get(tenantId: string, id: string): Promise<PolicyVersion | null> {
    return this.db.exclusive(() => {
      const row = this.db.get(
        `SELECT * FROM policies WHERE tenant_id = ? AND id = ?`,
        tenantId,
        id,
      );
      return row ? this.row(row) : null;
    });
  }

  list(tenantId: string): Promise<PolicyVersion[]> {
    return this.db.exclusive(() =>
      this.db
        .all(`SELECT * FROM policies WHERE tenant_id = ? ORDER BY name, version DESC`, tenantId)
        .map((r) => this.row(r)),
    );
  }

  setStatus(tenantId: string, id: string, status: PolicyStatus): Promise<PolicyVersion | null> {
    return this.db.exclusive(() => {
      const row = this.db.get(
        `UPDATE policies SET status = ? WHERE tenant_id = ? AND id = ? RETURNING *`,
        status,
        tenantId,
        id,
      );
      return row ? this.row(row) : null;
    });
  }

  /** Promote a version to active, archiving any previously-active version of the same name. */
  activate(tenantId: string, id: string): Promise<PolicyVersion | null> {
    return this.db.transaction(() => {
      const existing = this.db.get(
        `SELECT * FROM policies WHERE tenant_id = ? AND id = ?`,
        tenantId,
        id,
      );
      if (!existing) return null;
      const policy = this.row(existing);
      this.db.run(
        `UPDATE policies SET status = 'archived' WHERE tenant_id = ? AND name = ? AND status = 'active'`,
        tenantId,
        policy.name,
      );
      const row = this.db.get(
        `UPDATE policies SET status = 'active', activated_at = ? WHERE tenant_id = ? AND id = ? RETURNING *`,
        nowIso(),
        tenantId,
        id,
      );
      return row ? this.row(row) : null;
    });
  }

  /** Roll back: the current active version becomes rolled_back; the prior version reactivates. */
  rollback(
    tenantId: string,
    name: string,
  ): Promise<{ rolledBack: PolicyVersion | null; restored: PolicyVersion | null }> {
    return this.db.transaction(() => {
      const cur = this.db.get(
        `SELECT * FROM policies WHERE tenant_id = ? AND name = ? AND status = 'active' LIMIT 1`,
        tenantId,
        name,
      );
      const current = cur ? this.row(cur) : null;
      let restored: PolicyVersion | null = null;
      if (current) {
        this.db.run(
          `UPDATE policies SET status = 'rolled_back' WHERE tenant_id = ? AND id = ?`,
          tenantId,
          current.id,
        );
        const prior = this.db.get<{ id: string }>(
          `SELECT * FROM policies WHERE tenant_id = ? AND name = ? AND version < ? AND status = 'archived'
           ORDER BY version DESC LIMIT 1`,
          tenantId,
          name,
          current.version,
        );
        if (prior) {
          const r = this.db.get(
            `UPDATE policies SET status = 'active', activated_at = ? WHERE id = ? RETURNING *`,
            nowIso(),
            prior.id,
          );
          restored = this.row(r!);
        }
      }
      return { rolledBack: current, restored };
    });
  }

  /** Active policy artifacts for a tenant (to fold into the cascade alongside shipped packs). */
  getActiveArtifacts(tenantId: string): Promise<unknown[]> {
    return this.artifactsWithStatus(tenantId, "active");
  }

  getShadowArtifacts(tenantId: string): Promise<unknown[]> {
    return this.artifactsWithStatus(tenantId, "shadow");
  }

  private artifactsWithStatus(tenantId: string, status: PolicyStatus): Promise<unknown[]> {
    return this.db.exclusive(() =>
      this.db
        .all<{ artifact: unknown }>(
          `SELECT artifact FROM policies WHERE tenant_id = ? AND status = ?`,
          tenantId,
          status,
        )
        .map((r) => parseJson(r.artifact)),
    );
  }
}

// ---------------------------------------------------------------------------------------
// Assurance
// ---------------------------------------------------------------------------------------

interface StatsRow {
  total: number;
  upheld: number | null;
}

/** Embedded assurance sampling, audit verdicts, and readiness exceptions; see `AssuranceStore`. */
export class EmbeddedAssuranceStore implements AssuranceStorePort {
  constructor(private readonly db: EmbeddedDb) {}

  /** Enqueue audits for candidate verdicts not yet sampled. Returns how many were added. */
  sample(
    tenantId: string,
    candidates: Array<{ recordSequence: number; pack: string | null; decision: string }>,
  ): Promise<number> {
    return this.db.transaction(() => {
      let added = 0;
      for (const c of candidates) {
        const res = this.db.run(
          `INSERT INTO assurance_audits (id, tenant_id, record_sequence, pack, machine_decision, created_at)
           VALUES (?,?,?,?,?,?) ON CONFLICT (tenant_id, record_sequence) DO NOTHING`,
          randomUUID(),
          tenantId,
          c.recordSequence,
          c.pack,
          c.decision,
          nowIso(),
        );
        if (Number(res.changes) > 0) added += 1;
      }
      return added;
    });
  }

  listPending(tenantId: string, limit = 100): Promise<AssuranceAudit[]> {
    return this.db.exclusive(() =>
      this.db
        .all(
          `SELECT * FROM assurance_audits WHERE tenant_id = ? AND status = 'pending'
           ORDER BY created_at ASC, rowid ASC LIMIT ?`,
          tenantId,
          limit,
        )
        .map((r) => this.row(r)),
    );
  }

  recordAudit(tenantId: string, id: string, upheld: boolean, auditedBy: string): Promise<void> {
    return this.db.exclusive(() => {
      this.db.run(
        `UPDATE assurance_audits SET upheld = ?, status = 'audited', audited_by = ?, audited_at = ?
         WHERE tenant_id = ? AND id = ?`,
        upheld ? 1 : 0,
        auditedBy,
        nowIso(),
        tenantId,
        id,
      );
    });
  }

  /** Upheld counts over audited samples, optionally filtered by pack. */
  stats(tenantId: string, pack?: string): Promise<AssuranceStats> {
    return this.db.exclusive(() => {
      const params: string[] = [tenantId];
      let where = `tenant_id = ? AND status = 'audited'`;
      if (pack) {
        params.push(pack);
        where += ` AND pack = ?`;
      }
      const row = this.db.get<StatsRow>(
        `SELECT count(*) AS total, COALESCE(sum(CASE WHEN upheld = 1 THEN 1 ELSE 0 END), 0) AS upheld
         FROM assurance_audits WHERE ${where}`,
        ...params,
      );
      return { total: Number(row?.total ?? 0), upheld: Number(row?.upheld ?? 0) };
    });
  }

  statsByPack(tenantId: string): Promise<Record<string, AssuranceStats>> {
    return this.db.exclusive(() => {
      const rows = this.db.all<StatsRow & { pack: string }>(
        `SELECT COALESCE(pack, 'core') AS pack, count(*) AS total,
                COALESCE(sum(CASE WHEN upheld = 1 THEN 1 ELSE 0 END), 0) AS upheld
         FROM assurance_audits WHERE tenant_id = ? AND status = 'audited'
         GROUP BY assurance_audits.pack`,
        tenantId,
      );
      const out: Record<string, AssuranceStats> = {};
      for (const r of rows) out[r.pack] = { total: Number(r.total), upheld: Number(r.upheld) };
      return out;
    });
  }

  // --- Readiness-gate exceptions ---
  grantException(tenantId: string, checkId: string, owner: string, reason?: string): Promise<void> {
    return this.db.exclusive(() => {
      this.db.run(
        `INSERT INTO readiness_exceptions (tenant_id, check_id, owner, reason, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT (tenant_id, check_id) DO UPDATE SET owner = excluded.owner, reason = excluded.reason`,
        tenantId,
        checkId,
        owner,
        reason ?? null,
        nowIso(),
      );
    });
  }

  revokeException(tenantId: string, checkId: string): Promise<void> {
    return this.db.exclusive(() => {
      this.db.run(
        `DELETE FROM readiness_exceptions WHERE tenant_id = ? AND check_id = ?`,
        tenantId,
        checkId,
      );
    });
  }

  exceptions(tenantId: string): Promise<Record<string, string>> {
    return this.db.exclusive(() => {
      const rows = this.db.all<{ check_id: string; owner: string }>(
        `SELECT check_id, owner FROM readiness_exceptions WHERE tenant_id = ?`,
        tenantId,
      );
      const out: Record<string, string> = {};
      for (const r of rows) out[r.check_id] = r.owner;
      return out;
    });
  }

  private row(r: Record<string, unknown>): AssuranceAudit {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      recordSequence: Number(r.record_sequence),
      pack: (r.pack as string) ?? null,
      machineDecision: (r.machine_decision as string) ?? null,
      upheld: r.upheld == null ? null : toBool(r.upheld),
      status: r.status as "pending" | "audited",
    };
  }
}
