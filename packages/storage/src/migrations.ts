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
  {
    version: "0002_gatehouse",
    sql: /* sql */ `
      -- Tenant lifecycle. Evidence-retention rules survive tenant deletion where required.
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id     TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active', -- active | suspended | deleted
        kms_key_name  TEXT NOT NULL,
        evidence_prefix TEXT NOT NULL,
        retain_evidence_on_delete BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Scoped API keys (machine identities). Only the secret hash is stored.
      CREATE TABLE IF NOT EXISTS api_keys (
        key_id       TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        secret_hash  TEXT NOT NULL,
        scopes       JSONB NOT NULL DEFAULT '[]',
        status       TEXT NOT NULL DEFAULT 'active', -- active | revoked
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at   TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);

      -- Hash-chained access audit: who viewed/exported/shared which evidence, when.
      CREATE TABLE IF NOT EXISTS access_audit (
        tenant_id    TEXT NOT NULL,
        sequence     BIGINT NOT NULL,
        id           UUID NOT NULL,
        actor        TEXT NOT NULL,
        actor_kind   TEXT NOT NULL,
        action       TEXT NOT NULL,  -- view | export | share | verify
        resource     TEXT NOT NULL,  -- e.g. record:42, chain, claims-pack:abc
        metadata     JSONB NOT NULL DEFAULT '{}',
        prev_hash    TEXT NOT NULL,
        entry_hash   TEXT NOT NULL,
        at           TEXT NOT NULL,  -- ISO-8601 stored verbatim so the entry hash round-trips exactly
        PRIMARY KEY (tenant_id, sequence),
        UNIQUE (id)
      );
      CREATE TABLE IF NOT EXISTS access_audit_head (
        tenant_id     TEXT PRIMARY KEY,
        last_sequence BIGINT NOT NULL,
        last_hash     TEXT NOT NULL
      );

      -- Row-level security: defense-in-depth tenant isolation on the evidence tables.
      -- Even if application code omits a tenant filter, the database refuses cross-tenant
      -- rows. Access is scoped per request via SET LOCAL pharos.tenant_id.
      ALTER TABLE action_records ENABLE ROW LEVEL SECURITY;
      ALTER TABLE action_records FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS action_records_tenant_isolation ON action_records;
      CREATE POLICY action_records_tenant_isolation ON action_records
        USING (tenant_id = current_setting('pharos.tenant_id', true))
        WITH CHECK (tenant_id = current_setting('pharos.tenant_id', true));

      ALTER TABLE access_audit ENABLE ROW LEVEL SECURITY;
      ALTER TABLE access_audit FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS access_audit_tenant_isolation ON access_audit;
      CREATE POLICY access_audit_tenant_isolation ON access_audit
        USING (tenant_id = current_setting('pharos.tenant_id', true))
        WITH CHECK (tenant_id = current_setting('pharos.tenant_id', true));
    `,
  },
  {
    version: "0003_rls_app_role",
    sql: /* sql */ `
      -- Superusers and BYPASSRLS roles ignore row-level security, so the application
      -- assumes a dedicated NOBYPASSRLS role per tenant-scoped transaction (SET LOCAL
      -- ROLE). Only then does the RLS policy actually confine queries to one tenant.
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pharos_app') THEN
          CREATE ROLE pharos_app NOBYPASSRLS;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO pharos_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pharos_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pharos_app;
    `,
  },
  {
    version: "0004_causeway",
    sql: /* sql */ `
      -- Programmatic mandates: scope, limits, grantor, expiry, versioned. A verdict
      -- evaluates mandate scope as a Tier-1 input and seals the mandate into the record.
      CREATE TABLE IF NOT EXISTS mandates (
        tenant_id   TEXT NOT NULL,
        mandate_id  TEXT NOT NULL,
        version     INTEGER NOT NULL,
        scope       TEXT NOT NULL,
        limits      JSONB NOT NULL DEFAULT '{}',
        grantor     TEXT NOT NULL,
        expires_at  TIMESTAMPTZ,
        status      TEXT NOT NULL DEFAULT 'active', -- active | revoked
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, mandate_id, version)
      );

      -- Workflow continuation: escalated actions park here with full context until a human
      -- verdict resumes (approve/modify/reject) the agent's pending step. resumed_at is
      -- claimed atomically to guarantee exactly-once side effects.
      CREATE TABLE IF NOT EXISTS escalations (
        id              UUID PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        record_sequence BIGINT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | modified | rejected | cancelled
        context         JSONB NOT NULL,
        resolution      JSONB,
        resolved_by     TEXT,
        idempotency_key TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at     TIMESTAMPTZ,
        resumed_at      TIMESTAMPTZ,
        UNIQUE (tenant_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS escalations_tenant_status_idx ON escalations (tenant_id, status);
    `,
  },
  {
    version: "0005_watchroom",
    sql: /* sql */ `
      -- Review-ops: route each escalation to a queue with a priority and an SLA deadline.
      ALTER TABLE escalations ADD COLUMN IF NOT EXISTS queue TEXT NOT NULL DEFAULT 'general';
      ALTER TABLE escalations ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 4;
      ALTER TABLE escalations ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;
      ALTER TABLE escalations ADD COLUMN IF NOT EXISTS assigned_to TEXT;
      ALTER TABLE escalations ADD COLUMN IF NOT EXISTS four_eyes BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE escalations ADD COLUMN IF NOT EXISTS sla_breach_notified BOOLEAN NOT NULL DEFAULT false;
      CREATE INDEX IF NOT EXISTS escalations_queue_idx ON escalations (tenant_id, queue, status);

      -- Notification audit: which alerts fired for which escalation, when.
      CREATE TABLE IF NOT EXISTS review_notifications (
        id          UUID PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        escalation_id UUID,
        queue       TEXT,
        channel     TEXT NOT NULL,   -- email | slack | teams | webhook
        event       TEXT NOT NULL,   -- assigned | at_risk | breached | resolved | digest
        sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS review_notifications_tenant_idx ON review_notifications (tenant_id, event);
    `,
  },
  {
    version: "0006_seal",
    sql: /* sql */ `
      -- Selective-disclosure redaction commitments (additive; do not change contentHash).
      ALTER TABLE action_records ADD COLUMN IF NOT EXISTS disclosure_root TEXT;
      ALTER TABLE action_records ADD COLUMN IF NOT EXISTS disclosure_sig TEXT;
      ALTER TABLE action_records ADD COLUMN IF NOT EXISTS salts JSONB;
      ALTER TABLE action_records ADD COLUMN IF NOT EXISTS commitments JSONB;

      -- Trusted-time anchors: chain heads signed by an independent timestamp authority.
      CREATE TABLE IF NOT EXISTS chain_anchors (
        id            UUID PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        sequence      BIGINT NOT NULL,
        head_hash     TEXT NOT NULL,
        tsa_time      TEXT NOT NULL,
        tsa_signature TEXT NOT NULL,
        tsa_key_id    TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chain_anchors_tenant_idx ON chain_anchors (tenant_id, sequence);

      -- Litigation hold: freezes retention + disables redaction on scoped record sets.
      CREATE TABLE IF NOT EXISTS legal_holds (
        id            UUID PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        name          TEXT NOT NULL,
        reason        TEXT,
        from_sequence BIGINT,
        to_sequence   BIGINT,
        status        TEXT NOT NULL DEFAULT 'active', -- active | released
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        released_at   TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS legal_holds_tenant_idx ON legal_holds (tenant_id, status);

      -- Claims packs: scoped, audience-targeted evidence bundles.
      CREATE TABLE IF NOT EXISTS claims_packs (
        id            UUID PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        incident      TEXT,
        audience      TEXT NOT NULL,    -- claims_adjuster | outside_counsel | regulator | broker
        from_sequence BIGINT NOT NULL,
        to_sequence   BIGINT NOT NULL,
        redact_fields JSONB NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'draft', -- draft | sealed | released
        bundle        JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        sealed_at     TIMESTAMPTZ,
        released_at   TIMESTAMPTZ,
        released_to   TEXT
      );
      CREATE INDEX IF NOT EXISTS claims_packs_tenant_idx ON claims_packs (tenant_id, status);
    `,
  },
  {
    version: "0007_codex",
    sql: /* sql */ `
      -- Policy lifecycle: versioned, per-tenant compiled policies with draft/shadow/active
      -- states and one-click rollback. Shipped regulation packs (FINRA/HIPAA) live in code;
      -- this table holds tenant-authored policies compiled from natural language.
      CREATE TABLE IF NOT EXISTS policies (
        id           UUID PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        name         TEXT NOT NULL,
        version      INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'draft', -- draft | shadow | active | rolled_back | archived
        artifact     JSONB NOT NULL,
        source_text  TEXT,
        changelog    TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        activated_at TIMESTAMPTZ,
        UNIQUE (tenant_id, name, version)
      );
      CREATE INDEX IF NOT EXISTS policies_status_idx ON policies (tenant_id, status);
    `,
  },
  {
    version: "0008_beam_count",
    sql: /* sql */ `
      -- Assurance: sampled verdicts routed to human audit; the upheld fraction yields the
      -- measured Wilson-score accuracy bound (replacing the modeled placeholder).
      CREATE TABLE IF NOT EXISTS assurance_audits (
        id               UUID PRIMARY KEY,
        tenant_id        TEXT NOT NULL,
        record_sequence  BIGINT NOT NULL,
        pack             TEXT,
        machine_decision TEXT,
        upheld           BOOLEAN,
        status           TEXT NOT NULL DEFAULT 'pending', -- pending | audited
        audited_by       TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        audited_at       TIMESTAMPTZ,
        UNIQUE (tenant_id, record_sequence)
      );
      CREATE INDEX IF NOT EXISTS assurance_audits_idx ON assurance_audits (tenant_id, status, pack);

      -- Readiness-gate exceptions: owner-granted overrides for a failing check.
      CREATE TABLE IF NOT EXISTS readiness_exceptions (
        tenant_id  TEXT NOT NULL,
        check_id   TEXT NOT NULL,
        owner      TEXT NOT NULL,
        reason     TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, check_id)
      );
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
