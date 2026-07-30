import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export interface HeldGatewayRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export type HeldRequestAcquireResult =
  | { status: "missing" }
  | { status: "busy" }
  | { status: "acquired"; leaseToken: string; request: HeldGatewayRequest };

export interface HeldRequestStore {
  save(tenantId: string, escalationId: string, request: HeldGatewayRequest): Promise<void>;
  acquire(tenantId: string, escalationId: string): Promise<HeldRequestAcquireResult>;
  complete(tenantId: string, escalationId: string, leaseToken: string): Promise<boolean>;
  release(
    tenantId: string,
    escalationId: string,
    leaseToken: string,
    error: string,
  ): Promise<boolean>;
}

export type HeldRequestKeyProvider = (tenantId: string) => Promise<Uint8Array> | Uint8Array;

interface HeldRequestRow {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
}

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_LEASE_MS = 30_000;

/**
 * Derive a distinct AES-256 key for every tenant from a secret master key.
 *
 * The master belongs in a secret manager / mounted secret, never source control. Tenant
 * separation in the HKDF info field prevents ciphertext copied between tenant rows from
 * decrypting, while AES-GCM AAD also binds each blob to its tenant and escalation id.
 */
export function heldRequestKeyProviderFromMaster(masterKey: Uint8Array): HeldRequestKeyProvider {
  if (masterKey.byteLength < 32) {
    throw new Error("held-request master key must contain at least 32 bytes");
  }
  const master = Buffer.from(masterKey);
  return (tenantId: string) =>
    new Uint8Array(
      hkdfSync(
        "sha256",
        master,
        Buffer.from("pharos-held-request-store-v1", "utf8"),
        Buffer.from(tenantId, "utf8"),
        32,
      ),
    );
}

/**
 * Encrypted, tenant-isolated durable storage for gateway continuations.
 *
 * acquire() is a leased state transition. Only one gateway instance can deliver a held
 * request at a time; an abandoned lease becomes recoverable after the bounded lease
 * window. complete() and release() require the unguessable lease token, so a stale worker
 * cannot delete or reopen work acquired by a replacement.
 */
export class PostgresHeldRequestStore implements HeldRequestStore {
  private readonly maxBytes: number;
  private readonly leaseMs: number;

  constructor(
    private readonly pool: Pool,
    private readonly keyProvider: HeldRequestKeyProvider,
    options: { maxBytes?: number; leaseMs?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("held-request maxBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) {
      throw new Error("held-request leaseMs must be a positive safe integer");
    }
  }

  async save(tenantId: string, escalationId: string, request: HeldGatewayRequest): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(request), "utf8");
    if (plaintext.byteLength > this.maxBytes) {
      throw new Error(
        `held request is ${plaintext.byteLength} bytes; limit is ${this.maxBytes} bytes`,
      );
    }
    const key = await this.keyFor(tenantId);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(this.aad(tenantId, escalationId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO gateway_held_requests
           (tenant_id, escalation_id, ciphertext, nonce, auth_tag)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, escalation_id) DO NOTHING`,
        [tenantId, escalationId, ciphertext, nonce, authTag],
      );
    });
  }

  async acquire(tenantId: string, escalationId: string): Promise<HeldRequestAcquireResult> {
    const leaseToken = randomUUID();
    return this.withTenant(tenantId, async (client) => {
      const acquired = await client.query<HeldRequestRow>(
        `UPDATE gateway_held_requests
            SET state = 'delivering',
                lease_token = $3,
                lease_expires_at = now() + ($4 * interval '1 millisecond'),
                attempts = attempts + 1,
                updated_at = now()
          WHERE tenant_id = $1
            AND escalation_id = $2
            AND (state = 'pending' OR lease_expires_at <= now())
          RETURNING ciphertext, nonce, auth_tag`,
        [tenantId, escalationId, leaseToken, this.leaseMs],
      );
      const row = acquired.rows[0];
      if (row) {
        return {
          status: "acquired",
          leaseToken,
          request: await this.decrypt(tenantId, escalationId, row),
        };
      }
      const exists = await client.query(
        `SELECT 1 FROM gateway_held_requests WHERE tenant_id = $1 AND escalation_id = $2`,
        [tenantId, escalationId],
      );
      return { status: exists.rowCount ? "busy" : "missing" };
    });
  }

  async complete(tenantId: string, escalationId: string, leaseToken: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM gateway_held_requests
          WHERE tenant_id = $1 AND escalation_id = $2 AND lease_token = $3`,
        [tenantId, escalationId, leaseToken],
      );
      return result.rowCount === 1;
    });
  }

  async release(
    tenantId: string,
    escalationId: string,
    leaseToken: string,
    error: string,
  ): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE gateway_held_requests
            SET state = 'pending',
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error = $4,
                updated_at = now()
          WHERE tenant_id = $1 AND escalation_id = $2 AND lease_token = $3`,
        [tenantId, escalationId, leaseToken, error.slice(0, 2000)],
      );
      return result.rowCount === 1;
    });
  }

  private async decrypt(
    tenantId: string,
    escalationId: string,
    row: HeldRequestRow,
  ): Promise<HeldGatewayRequest> {
    const key = await this.keyFor(tenantId);
    const decipher = createDecipheriv(ALGORITHM, key, row.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(this.aad(tenantId, escalationId));
    decipher.setAuthTag(row.auth_tag);
    const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as HeldGatewayRequest;
    if (
      !parsed ||
      typeof parsed.method !== "string" ||
      typeof parsed.path !== "string" ||
      !parsed.headers ||
      typeof parsed.headers !== "object"
    ) {
      throw new Error("decrypted held request has an invalid schema");
    }
    return parsed;
  }

  private async keyFor(tenantId: string): Promise<Buffer> {
    const key = Buffer.from(await this.keyProvider(tenantId));
    if (key.byteLength !== 32) {
      throw new Error("held-request key provider must return exactly 32 bytes");
    }
    return key;
  }

  private aad(tenantId: string, escalationId: string): Buffer {
    return Buffer.from(`pharos-held-request-v1\0${tenantId}\0${escalationId}`, "utf8");
  }

  private async withTenant<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE pharos_app");
      await client.query("SELECT set_config('pharos.tenant_id', $1, true)", [tenantId]);
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
