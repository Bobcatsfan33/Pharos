import { loadConfig, type PharosConfig } from "@pharos/config";
import {
  FileKeystore,
  LocalKms,
  VerdictEngine,
  type SigningProvider,
} from "@pharos/core";
import {
  ChainIntegrityService,
  EvidenceStore,
  VerdictCache,
  WormStore,
  createPool,
  runMigrations,
  type Pool,
} from "@pharos/storage";

/**
 * The composition root: build the durable platform spine from configuration.
 *
 * One pipeline, two consumers. A submitted action flows through the verdict engine
 * (Beam) and the evidence store (Ledger) inside a single transaction. Everything is
 * durable — Postgres, WORM, KMS — so the platform survives restarts with the chain
 * intact. There are no in-memory or file-backed stores of platform/evidence state.
 */
export interface Platform {
  config: PharosConfig;
  pool: Pool;
  signer: SigningProvider;
  worm: WormStore;
  cache: VerdictCache;
  store: EvidenceStore;
  engine: VerdictEngine;
  integrity: ChainIntegrityService;
  close: () => Promise<void>;
}

export function buildSigner(config: PharosConfig): SigningProvider {
  if (config.kms.provider === "local-kms") {
    return new LocalKms(new FileKeystore(config.kms.keystoreDir));
  }
  // aws-kms wiring is introduced in a later sprint; fail explicitly until then.
  throw new Error(`KMS provider not yet supported: ${config.kms.provider}`);
}

export async function buildPlatform(config: PharosConfig = loadConfig()): Promise<Platform> {
  const pool = createPool(config.pg.url);
  await runMigrations(pool);

  const signer = buildSigner(config);

  const worm = new WormStore({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    bucket: config.s3.bucket,
    accessKey: config.s3.accessKey,
    secretKey: config.s3.secretKey,
    forcePathStyle: config.s3.forcePathStyle,
    retentionDays: config.s3.wormRetentionDays,
  });
  await worm.ensureBucket();

  const cache = new VerdictCache(config.redis.url);

  // Sprint 0: per-environment signing key. Sprint 1 swaps this resolver for per-tenant keys.
  const resolveKeyName = (_tenantId: string) => `pharos-${config.env}`;

  const store = new EvidenceStore({ pool, worm, signer, resolveKeyName });
  const engine = new VerdictEngine({ deadlineMs: config.api.verdictDeadlineMs });
  const integrity = new ChainIntegrityService({
    store,
    signer,
    onBreak: (report) => {
      // Structured alert; Sprint 8 wires this into the observability/alerting stack.
      console.error("[chain-integrity] BREAK detected", JSON.stringify(report.errors));
    },
  });

  return {
    config,
    pool,
    signer,
    worm,
    cache,
    store,
    engine,
    integrity,
    close: async () => {
      integrity.stop();
      await cache.close().catch(() => {});
      await pool.end();
    },
  };
}
