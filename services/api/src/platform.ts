import { loadConfig, type PharosConfig } from "@pharos/config";
import {
  FileKeystore,
  LocalKms,
  VerdictEngine,
  type SigningProvider,
} from "@pharos/core";
import {
  AccessAuditLog,
  ApiKeyStore,
  ChainIntegrityService,
  EvidenceStore,
  TenantStore,
  VerdictCache,
  WormStore,
  createPool,
  runMigrations,
  type Pool,
} from "@pharos/storage";
import { OidcVerifier, type OidcIssuerConfig } from "@pharos/identity";
import { loadDefaultRegistry, type ModelRegistry } from "@pharos/judge";
import { VerdictCascade, DEFAULT_PACK_BINDINGS } from "@pharos/cascade";

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
  registry: ModelRegistry;
  cascade: VerdictCascade;
  integrity: ChainIntegrityService;
  tenants: TenantStore;
  apiKeys: ApiKeyStore;
  accessAudit: AccessAuditLog;
  oidc: OidcVerifier;
  close: () => Promise<void>;
}

export interface BuildPlatformOptions {
  /** Override OIDC issuer configs (tests inject local JWKS issuers). */
  oidcIssuers?: OidcIssuerConfig[];
}

export function buildSigner(config: PharosConfig): SigningProvider {
  if (config.kms.provider === "local-kms") {
    return new LocalKms(new FileKeystore(config.kms.keystoreDir));
  }
  // aws-kms wiring is introduced in a later sprint; fail explicitly until then.
  throw new Error(`KMS provider not yet supported: ${config.kms.provider}`);
}

export async function buildPlatform(
  config: PharosConfig = loadConfig(),
  options: BuildPlatformOptions = {},
): Promise<Platform> {
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

  // Sprint 1: per-tenant signing keys (matches TenantStore.kmsKeyName).
  const resolveKeyName = (tenantId: string) => `tenant:${tenantId}`;

  const store = new EvidenceStore({ pool, worm, signer, resolveKeyName });
  const engine = new VerdictEngine({ deadlineMs: config.api.verdictDeadlineMs });
  const registry = loadDefaultRegistry();
  const cascade = new VerdictCascade({
    engine,
    registry,
    deadlineMs: config.api.verdictDeadlineMs,
    packs: DEFAULT_PACK_BINDINGS,
  });
  const integrity = new ChainIntegrityService({
    store,
    signer,
    onBreak: (report) => {
      // Structured alert; Sprint 8 wires this into the observability/alerting stack.
      console.error("[chain-integrity] BREAK detected", JSON.stringify(report.errors));
    },
  });

  const tenants = new TenantStore(pool);
  const apiKeys = new ApiKeyStore(pool);
  const accessAudit = new AccessAuditLog(pool);
  const oidcIssuers = options.oidcIssuers ?? (config.oidc as OidcIssuerConfig[]);
  const oidc = new OidcVerifier(oidcIssuers);

  return {
    config,
    pool,
    signer,
    worm,
    cache,
    store,
    engine,
    registry,
    cascade,
    integrity,
    tenants,
    apiKeys,
    accessAudit,
    oidc,
    close: async () => {
      integrity.stop();
      await cache.close().catch(() => {});
      await pool.end();
    },
  };
}
