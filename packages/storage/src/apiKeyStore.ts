import type { Pool } from "pg";
import {
  type GeneratedApiKey,
  type Permission,
  generateApiKey,
  parseApiKey,
  verifySecret,
} from "@pharos/identity";

export interface ApiKeyRecord {
  keyId: string;
  tenantId: string;
  name: string;
  scopes: Permission[];
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
}

export interface VerifiedApiKey {
  keyId: string;
  tenantId: string;
  scopes: Permission[];
  name: string;
}

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
 * Storage for scoped API keys. Only secret hashes are persisted. Rotation creates a new
 * active key without revoking the old one, so callers can roll forward with zero dropped
 * ingestion; the old key is revoked explicitly once traffic has moved.
 */
export class ApiKeyStore {
  constructor(private readonly pool: Pool) {}

  async create(
    tenantId: string,
    name: string,
    scopes: Permission[],
  ): Promise<{ record: ApiKeyRecord; plaintext: string }> {
    const generated: GeneratedApiKey = generateApiKey();
    const res = await this.pool.query<KeyRow>(
      `INSERT INTO api_keys (key_id, tenant_id, name, secret_hash, scopes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [generated.keyId, tenantId, name, generated.secretHash, JSON.stringify(scopes)],
    );
    return { record: this.rowTo(res.rows[0]!), plaintext: generated.plaintext };
  }

  /** Verify a presented plaintext key. Returns the identity if active, else null. */
  async verify(plaintext: string): Promise<VerifiedApiKey | null> {
    const parsed = parseApiKey(plaintext);
    if (!parsed) return null;
    const res = await this.pool.query<KeyRow>(`SELECT * FROM api_keys WHERE key_id = $1`, [
      parsed.keyId,
    ]);
    const row = res.rows[0];
    if (!row || row.status !== "active") return null;
    if (!verifySecret(parsed.secret, row.secret_hash)) return null;
    await this.pool.query(`UPDATE api_keys SET last_used_at = now() WHERE key_id = $1`, [
      parsed.keyId,
    ]);
    return {
      keyId: row.key_id,
      tenantId: row.tenant_id,
      scopes: this.scopesOf(row),
      name: row.name,
    };
  }

  /** Rotate: mint a new key for the same tenant/scopes. The old key stays active. */
  async rotate(
    tenantId: string,
    oldKeyId: string,
  ): Promise<{ record: ApiKeyRecord; plaintext: string } | null> {
    const res = await this.pool.query<KeyRow>(
      `SELECT * FROM api_keys WHERE key_id = $1 AND tenant_id = $2`,
      [oldKeyId, tenantId],
    );
    const old = res.rows[0];
    if (!old) return null;
    return this.create(tenantId, `${old.name} (rotated)`, this.scopesOf(old));
  }

  async revoke(tenantId: string, keyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE api_keys SET status = 'revoked', revoked_at = now() WHERE key_id = $1 AND tenant_id = $2`,
      [keyId, tenantId],
    );
  }

  async list(tenantId: string): Promise<ApiKeyRecord[]> {
    const res = await this.pool.query<KeyRow>(
      `SELECT * FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return res.rows.map((r) => this.rowTo(r));
  }

  private scopesOf(row: KeyRow): Permission[] {
    const raw = typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes;
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
