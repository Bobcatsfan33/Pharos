import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * The embedded operational database: one SQLite file opened with `node:sqlite` (built into
 * Node ≥ 22.13, no native build step), WAL journaling, and `synchronous=FULL` so a commit
 * returned to the caller has reached disk.
 *
 * `node:sqlite` is synchronous and every store shares this one connection. Because a
 * statement issued while another caller's transaction is open on the same connection would
 * silently join that transaction, ALL access goes through `exclusive()`: an in-process
 * async lock that serialises store operations. This is the embedded analogue of Postgres's
 * per-tenant `FOR UPDATE` head lock — coarser, honest for a single-process on-ramp, and
 * stated as such in the backend's posture.
 */
export class EmbeddedDb {
  private readonly db: DatabaseSync;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly statements = new Map<string, StatementSync>();

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  /** Run `fn` with exclusive access to the connection. Calls are queued, never interleaved. */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Run a write transaction (`BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK`) under the lock. */
  transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn();
        this.db.exec("COMMIT");
        return out;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlParam[]): { changes: number | bigint } {
    return this.prepare(sql).run(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}

export type SqlParam = string | number | bigint | null | Uint8Array;

/** SQLite's unique/primary-key violations (extended result codes 1555 and 2067). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { errcode?: number; code?: string; message?: string };
  if (e.errcode === 1555 || e.errcode === 2067) return true;
  return typeof e.message === "string" && /UNIQUE constraint failed|PRIMARY KEY/.test(e.message);
}

export function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

/** Parse a JSON column that may already be an object (mirrors the Postgres stores). */
export function parseJson(v: unknown): unknown {
  return typeof v === "string" ? JSON.parse(v) : v;
}

/**
 * Embedded schema. One consolidated version rather than a replay of the fourteen Postgres
 * migrations: the embedded backend has no deployed history to migrate, and SQLite has no
 * roles or row-level security to declare. Column names match the Postgres tables so the
 * two backends read the same shapes and the conformance suite is backend-blind.
 */
export const EMBEDDED_SCHEMA_VERSION = "e0001_embedded";

const SCHEMA = /* sql */ `
  CREATE TABLE IF NOT EXISTS tenant_chain_head (
    tenant_id     TEXT PRIMARY KEY,
    last_sequence INTEGER NOT NULL,
    last_hash     TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_records (
    tenant_id       TEXT    NOT NULL,
    sequence        INTEGER NOT NULL,
    id              TEXT    NOT NULL UNIQUE,
    content_hash    TEXT    NOT NULL,
    prev_hash       TEXT    NOT NULL,
    algorithm       TEXT    NOT NULL,
    key_id          TEXT    NOT NULL,
    signature       TEXT    NOT NULL,
    content         TEXT    NOT NULL,
    worm_key        TEXT,
    worm_version_id TEXT,
    decision        TEXT    NOT NULL,
    sealed_at       TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    disclosure_root TEXT,
    disclosure_sig  TEXT,
    salts           TEXT,
    commitments     TEXT,
    sig_version     INTEGER,
    PRIMARY KEY (tenant_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS action_records_content_hash_idx ON action_records (content_hash);

  CREATE TABLE IF NOT EXISTS ingest_idempotency (
    tenant_id           TEXT    NOT NULL,
    idempotency_key     TEXT    NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
    request_fingerprint TEXT    NOT NULL CHECK (length(request_fingerprint) = 64),
    sequence            INTEGER NOT NULL,
    created_at          TEXT    NOT NULL,
    PRIMARY KEY (tenant_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS tenants (
    tenant_id     TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',
    kms_key_name  TEXT NOT NULL,
    evidence_prefix TEXT NOT NULL,
    retain_evidence_on_delete INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    key_id       TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    secret_hash  TEXT NOT NULL,
    scopes       TEXT NOT NULL DEFAULT '[]',
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);

  CREATE TABLE IF NOT EXISTS access_audit (
    tenant_id    TEXT NOT NULL,
    sequence     INTEGER NOT NULL,
    id           TEXT NOT NULL UNIQUE,
    actor        TEXT NOT NULL,
    actor_kind   TEXT NOT NULL,
    action       TEXT NOT NULL,
    resource     TEXT NOT NULL,
    metadata     TEXT NOT NULL DEFAULT '{}',
    prev_hash    TEXT NOT NULL,
    entry_hash   TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (tenant_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS access_audit_head (
    tenant_id     TEXT PRIMARY KEY,
    last_sequence INTEGER NOT NULL,
    last_hash     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mandates (
    tenant_id   TEXT NOT NULL,
    mandate_id  TEXT NOT NULL,
    version     INTEGER NOT NULL,
    scope       TEXT NOT NULL,
    limits      TEXT NOT NULL DEFAULT '{}',
    grantor     TEXT NOT NULL,
    expires_at  TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL,
    PRIMARY KEY (tenant_id, mandate_id, version)
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL,
    record_sequence     INTEGER NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    context             TEXT NOT NULL,
    resolution          TEXT,
    resolved_by         TEXT,
    idempotency_key     TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    resolved_at         TEXT,
    resumed_at          TEXT,
    resume_claim_id     TEXT CHECK (resume_claim_id IS NULL OR length(resume_claim_id) BETWEEN 1 AND 255),
    queue               TEXT NOT NULL DEFAULT 'general',
    priority            INTEGER NOT NULL DEFAULT 4,
    sla_due_at          TEXT,
    assigned_to         TEXT,
    four_eyes           INTEGER NOT NULL DEFAULT 0,
    sla_breach_notified INTEGER NOT NULL DEFAULT 0,
    UNIQUE (tenant_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS escalations_queue_idx ON escalations (tenant_id, queue, status);

  CREATE TABLE IF NOT EXISTS review_notifications (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    escalation_id TEXT,
    queue         TEXT,
    channel       TEXT NOT NULL,
    event         TEXT NOT NULL,
    sent_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS review_notifications_tenant_idx ON review_notifications (tenant_id, event);

  CREATE TABLE IF NOT EXISTS chain_anchors (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    sequence      INTEGER NOT NULL,
    head_hash     TEXT NOT NULL,
    tsa_provider  TEXT NOT NULL DEFAULT 'local',
    tsa_time      TEXT NOT NULL,
    tsa_signature TEXT,
    tsa_key_id    TEXT,
    tsa_token     TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chain_anchors_tenant_idx ON chain_anchors (tenant_id, sequence);

  CREATE TABLE IF NOT EXISTS legal_holds (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    reason        TEXT,
    from_sequence INTEGER,
    to_sequence   INTEGER,
    status        TEXT NOT NULL DEFAULT 'active',
    created_by    TEXT,
    created_at    TEXT NOT NULL,
    released_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS claims_packs (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    incident      TEXT,
    audience      TEXT NOT NULL,
    from_sequence INTEGER NOT NULL,
    to_sequence   INTEGER NOT NULL,
    redact_fields TEXT NOT NULL DEFAULT '[]',
    status        TEXT NOT NULL DEFAULT 'draft',
    bundle        TEXT,
    created_at    TEXT NOT NULL,
    sealed_at     TEXT,
    released_at   TEXT,
    released_to   TEXT
  );

  CREATE TABLE IF NOT EXISTS policies (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    name         TEXT NOT NULL,
    version      INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'draft',
    artifact     TEXT NOT NULL,
    source_text  TEXT,
    changelog    TEXT,
    created_at   TEXT NOT NULL,
    activated_at TEXT,
    UNIQUE (tenant_id, name, version)
  );

  CREATE TABLE IF NOT EXISTS assurance_audits (
    id               TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL,
    record_sequence  INTEGER NOT NULL,
    pack             TEXT,
    machine_decision TEXT,
    upheld           INTEGER,
    status           TEXT NOT NULL DEFAULT 'pending',
    audited_by       TEXT,
    created_at       TEXT NOT NULL,
    audited_at       TEXT,
    UNIQUE (tenant_id, record_sequence)
  );

  CREATE TABLE IF NOT EXISTS readiness_exceptions (
    tenant_id  TEXT NOT NULL,
    check_id   TEXT NOT NULL,
    owner      TEXT NOT NULL,
    reason     TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, check_id)
  );
`;

export function runEmbeddedMigrations(db: EmbeddedDb): Promise<string[]> {
  return db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS pharos_migrations (
      version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    )`);
    const applied = db.get<{ version: string }>(
      "SELECT version FROM pharos_migrations WHERE version = ?",
      EMBEDDED_SCHEMA_VERSION,
    );
    if (applied) return [];
    db.exec(SCHEMA);
    db.run(
      "INSERT INTO pharos_migrations (version, applied_at) VALUES (?, ?)",
      EMBEDDED_SCHEMA_VERSION,
      new Date().toISOString(),
    );
    return [EMBEDDED_SCHEMA_VERSION];
  });
}
