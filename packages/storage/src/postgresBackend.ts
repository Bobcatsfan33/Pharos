import type { SigningProvider } from "@pharos/core";
import { createPool, type Pool } from "./pg.js";
import { runMigrations } from "./migrations.js";
import { WormStore, type WormStoreConfig } from "./wormStore.js";
import { EvidenceStore } from "./evidenceStore.js";
import { VerdictCache } from "./cache.js";
import { TenantStore } from "./tenantStore.js";
import { ApiKeyStore } from "./apiKeyStore.js";
import { AccessAuditLog } from "./accessAudit.js";
import { MandateStore } from "./mandateStore.js";
import { EscalationStore } from "./escalationStore.js";
import { ReviewNotifier, type ReviewNotifierOptions } from "./notifier.js";
import { EvidenceOpsStore } from "./evidenceOpsStore.js";
import { PolicyStore } from "./policyStore.js";
import { AssuranceStore } from "./assuranceStore.js";
import type { EvidencePosture, StorageBackend } from "./ports.js";

export interface PostgresStorageConfig {
  pgUrl: string;
  redisUrl: string;
  s3: WormStoreConfig;
}

export interface PostgresStorageDeps {
  /** The seal-path signer (already wrapped in its circuit breaker by the caller). */
  signer: SigningProvider;
  /** Resolve the KMS key name for a tenant. */
  resolveKeyName: (tenantId: string) => string;
  notifier?: ReviewNotifierOptions;
  now?: () => Date;
}

export const POSTGRES_EVIDENCE_POSTURE: EvidencePosture = {
  backend: "postgres",
  immutability: "s3-object-lock-compliance",
  worm: true,
  rowLevelSecurity: true,
  multiInstanceRateLimits: true,
  description:
    "Postgres operational state under row-level security, sealed records written to " +
    "S3 Object Lock (COMPLIANCE mode) inside the append transaction, Redis-backed rate limits.",
};

/** The Postgres backend: also exposes the pool for callers that need raw SQL (tests, gateway). */
export interface PostgresStorageBackend extends StorageBackend {
  readonly pool: Pool;
  readonly worm: WormStore;
}

/**
 * The production storage path, built exactly as `buildPlatform` always built it: pool,
 * migrations, the WORM bucket asserted to have Object Lock (fail closed), Redis, and the
 * stores. Lifted out of the composition root so a second backend can be selected by
 * configuration without the routes knowing.
 */
export async function buildPostgresStorage(
  config: PostgresStorageConfig,
  deps: PostgresStorageDeps,
): Promise<PostgresStorageBackend> {
  const pool = createPool(config.pgUrl);
  await runMigrations(pool);

  const worm = new WormStore(config.s3);
  await worm.ensureBucket();

  const counters = new VerdictCache(config.redisUrl);
  const store = new EvidenceStore({
    pool,
    worm,
    signer: deps.signer,
    resolveKeyName: deps.resolveKeyName,
    ...(deps.now ? { now: deps.now } : {}),
  });

  return {
    posture: POSTGRES_EVIDENCE_POSTURE,
    pool,
    worm,
    store,
    tenants: new TenantStore(pool),
    apiKeys: new ApiKeyStore(pool),
    accessAudit: new AccessAuditLog(pool),
    mandates: new MandateStore(pool),
    escalations: new EscalationStore(pool),
    notifier: new ReviewNotifier(pool, deps.notifier ?? {}),
    evidenceOps: new EvidenceOpsStore(pool),
    policyStore: new PolicyStore(pool),
    assurance: new AssuranceStore(pool),
    counters,
    close: async () => {
      await counters.close().catch(() => {});
      await pool.end();
    },
  };
}
