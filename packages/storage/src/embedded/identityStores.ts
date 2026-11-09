import { randomUUID } from "node:crypto";
import { GENESIS_HASH, sha256Hex } from "@pharos/core";
import {
  type GeneratedApiKey,
  type Permission,
  generateApiKey,
  parseApiKey,
  verifySecret,
} from "@pharos/identity";
import type { AccessAction, AccessAuditEntry, AccessAuditVerification } from "../accessAudit.js";
import type { ApiKeyRecord, VerifiedApiKey } from "../apiKeyStore.js";
import type { AccessAuditLogPort, ApiKeyStorePort, TenantStorePort } from "../ports.js";
import type { Tenant, TenantStatus } from "../tenantStore.js";
import { EmbeddedDb, nowIso, parseJson } from "./sqlite.js";

/** SQLite has no boolean type; the schema stores INTEGER 0/1. */
function toBool(v: unknown): boolean {
  return Boolean(Number(v));
}

// ---------------------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------------------

interface TenantRow {
  tenant_id: string;
  display_name: string;
  status: string;
  kms_key_name: string;
  evidence_prefix: string;
  retain_evidence_on_delete: number;
}

/**
 * Embedded tenant lifecycle. Mirrors `TenantStore`: create is an upsert on tenant_id that
 * refreshes the display name; delete marks the tenant deleted and removes its API keys
 * while leaving the sealed evidence chain intact when retention is set.
 */
export class EmbeddedTenantStore implements TenantStorePort {
  constructor(private readonly db: EmbeddedDb) {}

  private rowTo(row: TenantRow): Tenant {
    return {
      tenantId: row.tenant_id,
      displayName: row.display_name,
      status: row.status as TenantStatus,
      kmsKeyName: row.kms_key_name,
      evidencePrefix: row.evidence_prefix,
      retainEvidenceOnDelete: toBool(row.retain_evidence_on_delete),
    };
  }

  createTenant(input: {
    tenantId: string;
    displayName: string;
    retainEvidenceOnDelete?: boolean;
  }): Promise<Tenant> {
    const kmsKeyName = `tenant:${input.tenantId}`;
    const evidencePrefix = input.tenantId;
    return this.db.exclusive(() => {
      const now = nowIso();
      const row = this.db.get<TenantRow>(
        `INSERT INTO tenants
           (tenant_id, display_name, kms_key_name, evidence_prefix, retain_evidence_on_delete, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id) DO UPDATE SET display_name = excluded.display_name, updated_at = ?
         RETURNING *`,
        input.tenantId,
        input.displayName,
        kmsKeyName,
        evidencePrefix,
        (input.retainEvidenceOnDelete ?? true) ? 1 : 0,
        now,
        now,
        now,
      );
      return this.rowTo(row!);
    });
  }

  getTenant(tenantId: string): Promise<Tenant | null> {
    return this.db.exclusive(() => {
      const row = this.db.get<TenantRow>(`SELECT * FROM tenants WHERE tenant_id = ?`, tenantId);
      return row ? this.rowTo(row) : null;
    });
  }

  setStatus(tenantId: string, status: TenantStatus): Promise<void> {
    return this.db.exclusive(() => {
      this.db.run(
        `UPDATE tenants SET status = ?, updated_at = ? WHERE tenant_id = ?`,
        status,
        nowIso(),
        tenantId,
      );
    });
  }

  listTenants(): Promise<Tenant[]> {
    return this.db.exclusive(() =>
      this.db.all<TenantRow>(`SELECT * FROM tenants ORDER BY tenant_id`).map((r) => this.rowTo(r)),
    );
  }

  /**
   * Delete a tenant. Marks status deleted and removes API keys. The sealed evidence
   * (action_records + record files) is retained when retain_evidence_on_delete is set.
   * Returns whether evidence was retained.
   */
  deleteTenant(tenantId: string): Promise<{ evidenceRetained: boolean }> {
    return this.db.transaction(() => {
      const row = this.db.get<TenantRow>(`SELECT * FROM tenants WHERE tenant_id = ?`, tenantId);
      if (!row) return { evidenceRetained: false };
      const tenant = this.rowTo(row);
      this.db.run(`DELETE FROM api_keys WHERE tenant_id = ?`, tenantId);
      this.db.run(
        `UPDATE tenants SET status = 'deleted', updated_at = ? WHERE tenant_id = ?`,
        nowIso(),
        tenantId,
      );
      return { evidenceRetained: tenant.retainEvidenceOnDelete };
    });
  }
}

// ---------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------

interface KeyRow {
  key_id: string;
  tenant_id: string;
  name: string;
  secret_hash: string;
  scopes: unknown;
  status: string;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Embedded scoped API keys. Only secret hashes are persisted. Rotation mints a new active
 * key without revoking the old one, exactly as the Postgres store does.
 */
export class EmbeddedApiKeyStore implements ApiKeyStorePort {
  constructor(private readonly db: EmbeddedDb) {}

  create(
    tenantId: string,
    name: string,
    scopes: Permission[],
  ): Promise<{ record: ApiKeyRecord; plaintext: string }> {
    const generated: GeneratedApiKey = generateApiKey();
    return this.db.exclusive(() => {
      const row = this.db.get<KeyRow>(
        `INSERT INTO api_keys (key_id, tenant_id, name, secret_hash, scopes, created_at)
         VALUES (?,?,?,?,?,?) RETURNING *`,
        generated.keyId,
        tenantId,
        name,
        generated.secretHash,
        JSON.stringify(scopes),
        nowIso(),
      );
      return { record: this.rowTo(row!), plaintext: generated.plaintext };
    });
  }

  /** Verify a presented plaintext key. Returns the identity if active, else null. */
  verify(plaintext: string): Promise<VerifiedApiKey | null> {
    const parsed = parseApiKey(plaintext);
    if (!parsed) return Promise.resolve(null);
    return this.db.exclusive(() => {
      const row = this.db.get<KeyRow>(`SELECT * FROM api_keys WHERE key_id = ?`, parsed.keyId);
      if (!row || row.status !== "active") return null;
      if (!verifySecret(parsed.secret, row.secret_hash)) return null;
      this.db.run(`UPDATE api_keys SET last_used_at = ? WHERE key_id = ?`, nowIso(), parsed.keyId);
      return {
        keyId: row.key_id,
        tenantId: row.tenant_id,
        scopes: this.scopesOf(row),
        name: row.name,
      };
    });
  }

  /** Rotate: mint a new key for the same tenant/scopes. The old key stays active. */
  async rotate(
    tenantId: string,
    oldKeyId: string,
  ): Promise<{ record: ApiKeyRecord; plaintext: string } | null> {
    const old = await this.db.exclusive(() =>
      this.db.get<KeyRow>(
        `SELECT * FROM api_keys WHERE key_id = ? AND tenant_id = ?`,
        oldKeyId,
        tenantId,
      ),
    );
    if (!old) return null;
    return this.create(tenantId, `${old.name} (rotated)`, this.scopesOf(old));
  }

  revoke(tenantId: string, keyId: string): Promise<void> {
    return this.db.exclusive(() => {
      this.db.run(
        `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE key_id = ? AND tenant_id = ?`,
        nowIso(),
        keyId,
        tenantId,
      );
    });
  }

  list(tenantId: string): Promise<ApiKeyRecord[]> {
    return this.db.exclusive(() =>
      this.db
        .all<KeyRow>(
          `SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC`,
          tenantId,
        )
        .map((r) => this.rowTo(r)),
    );
  }

  private scopesOf(row: KeyRow): Permission[] {
    const raw = parseJson(row.scopes);
    return Array.isArray(raw) ? (raw as Permission[]) : [];
  }

  private rowTo(row: KeyRow): ApiKeyRecord {
    return {
      keyId: row.key_id,
      tenantId: row.tenant_id,
      name: row.name,
      scopes: this.scopesOf(row),
      status: row.status as "active" | "revoked",
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Access audit log
// ---------------------------------------------------------------------------------------

interface AuditRow {
  id: string;
  tenant_id: string;
  sequence: number;
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
 * The embedded access audit log: a per-tenant hash chain of every view, export, share, or
 * verification of evidence. `hashEntry` is byte-identical to the Postgres `AccessAuditLog`
 * so an audit chain is verifiable regardless of which backend wrote it. `record()` runs as
 * one SQLite transaction under the single write lock — the embedded analogue of the
 * Postgres per-tenant `FOR UPDATE` head lock.
 */
export class EmbeddedAccessAuditLog implements AccessAuditLogPort {
  constructor(
    private readonly db: EmbeddedDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  record(input: {
    tenantId: string;
    actor: string;
    actorKind: string;
    action: AccessAction;
    resource: string;
    metadata?: Record<string, unknown>;
  }): Promise<AccessAuditEntry> {
    return this.db.transaction(() => {
      this.db.run(
        `INSERT OR IGNORE INTO access_audit_head (tenant_id, last_sequence, last_hash)
         VALUES (?, -1, ?)`,
        input.tenantId,
        GENESIS_HASH,
      );
      const head = this.db.get<{ last_sequence: number; last_hash: string }>(
        `SELECT last_sequence, last_hash FROM access_audit_head WHERE tenant_id = ?`,
        input.tenantId,
      )!;
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
      this.db.run(
        `INSERT INTO access_audit
           (tenant_id, sequence, id, actor, actor_kind, action, resource, metadata, prev_hash, entry_hash, at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
      );
      this.db.run(
        `UPDATE access_audit_head SET last_sequence = ?, last_hash = ? WHERE tenant_id = ?`,
        sequence,
        entryHash,
        input.tenantId,
      );
      return { ...base, entryHash };
    });
  }

  list(tenantId: string): Promise<AccessAuditEntry[]> {
    return this.db.exclusive(() =>
      this.db
        .all<AuditRow>(
          `SELECT * FROM access_audit WHERE tenant_id = ? ORDER BY sequence ASC`,
          tenantId,
        )
        .map((r) => this.rowTo(r)),
    );
  }

  async verify(tenantId: string): Promise<AccessAuditVerification> {
    const entries = await this.list(tenantId);
    const out: AccessAuditVerification = {
      ok: true,
      entriesChecked: 0,
      firstBrokenSequence: null,
      errors: [],
    };
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
      metadata: (parseJson(row.metadata) ?? {}) as Record<string, unknown>,
      at: typeof row.at === "string" ? row.at : new Date(row.at).toISOString(),
      prevHash: row.prev_hash,
      entryHash: row.entry_hash,
    };
  }
}
