import type { Pool } from "pg";

/**
 * Schema migrations for operational state.
 *
 * Migrations are append-only and idempotent at the runner level (a migration is
 * applied at most once, tracked in pharos_migrations). The evidence chain lives in
 * action_records; tenant_chain_head serializes per-tenant appends and records the
 * head hash so a new record can link to its predecessor inside one transaction.
 */
export interface Migration {
  version: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: "0001_bedrock",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS tenant_chain_head (
        tenant_id     TEXT PRIMARY KEY,
        last_sequence BIGINT NOT NULL,
        last_hash     TEXT NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS action_records (
        tenant_id       TEXT   NOT NULL,
        sequence        BIGINT NOT NULL,
        id              UUID   NOT NULL,
        content_hash    TEXT   NOT NULL,
        prev_hash       TEXT   NOT NULL,
        algorithm       TEXT   NOT NULL,
        key_id          TEXT   NOT NULL,
        signature       TEXT   NOT NULL,
        content         JSONB  NOT NULL,
        worm_key        TEXT,
        worm_version_id TEXT,
        decision        TEXT   NOT NULL,
        sealed_at       TIMESTAMPTZ NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, sequence),
        UNIQUE (id)
      );

      CREATE INDEX IF NOT EXISTS action_records_tenant_seq_idx
        ON action_records (tenant_id, sequence);
      CREATE INDEX IF NOT EXISTS action_records_content_hash_idx
        ON action_records (content_hash);
    `,
  },
];

export async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pharos_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    const { rowCount } = await pool.query("SELECT 1 FROM pharos_migrations WHERE version = $1", [
      migration.version,
    ]);
    if (rowCount && rowCount > 0) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query("INSERT INTO pharos_migrations (version) VALUES ($1)", [migration.version]);
      await client.query("COMMIT");
      applied.push(migration.version);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}
