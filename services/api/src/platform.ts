import { randomUUID } from "node:crypto";
import { loadConfig, type PharosConfig } from "@pharos/config";
import {
  ResilientSigner,
  VerdictEngine,
  createSigningProvider,
  type SigningProvider,
  type PublicKeyEntry,
} from "@pharos/core";
import { createTsaProvider, type TsaProvider } from "@pharos/evidence";
import {
  AnchorScheduler,
  ChainIntegrityService,
  createStorageBackend,
  type AccessAuditLogPort,
  type ApiKeyStorePort,
  type AssuranceStorePort,
  type CounterStorePort,
  type EscalationStorePort,
  type EvidenceOpsStorePort,
  type EvidenceStorePort,
  type MandateStorePort,
  type PolicyStorePort,
  type Pool,
  type ReviewNotifierOptions,
  type ReviewNotifierPort,
  type StorageBackend,
  type TenantStorePort,
} from "@pharos/storage";
import { OidcVerifier, type OidcIssuerConfig } from "@pharos/identity";
import {
  assertQualifiedOnnxRuntime,
  createJudgeRegistry,
  loadManifest,
  servedConcerns,
  type JudgeLoader,
  type ModelRegistry,
} from "@pharos/judge";
import { VerdictCascade, DEFAULT_PACK_BINDINGS } from "@pharos/cascade";
import { SHIPPED_PACKS, artifactsOf, type PolicyArtifact } from "@pharos/policy";
import {
  JudgeDriftMonitor,
  MetricsRegistry,
  Tracer,
  loadJudgeDriftProfile,
} from "@pharos/observability";
import { ReviewSlaService } from "./reviewSla.js";

/**
 * The composition root: build the durable platform spine from configuration.
 *
 * One pipeline, two consumers. A submitted action flows through the verdict engine
 * (Beam) and the evidence store (Ledger) inside a single transaction, on whichever
 * storage backend configuration selects: Postgres + S3 Object Lock + Redis (the
 * production path; survives restarts with the chain intact and WORM-retained) or the
 * embedded SQLite + local-file backend (the zero-infrastructure on-ramp — durable and
 * tamper-evident, not WORM; see `storage.posture`). There are no in-memory stores of
 * platform or evidence state on either backend.
 */
export interface Platform {
  config: PharosConfig;
  /** The storage backend behind every store below, with its stated evidence posture. */
  storage: StorageBackend;
  /** Raw Postgres pool — present only on the Postgres backend (tests and the gateway use it). */
  pool?: Pool;
  signer: SigningProvider;
  cache: CounterStorePort;
  store: EvidenceStorePort;
  engine: VerdictEngine;
  registry: ModelRegistry;
  cascade: VerdictCascade;
  integrity: ChainIntegrityService;
  evidenceOps: EvidenceOpsStorePort;
  policyStore: PolicyStorePort;
  assurance: AssuranceStorePort;
  /** Active policy artifacts for a tenant (shipped packs + active custom policies). */
  activePolicyArtifacts: (tenantId: string) => Promise<PolicyArtifact[]>;
  metrics: MetricsRegistry;
  judgeDrift: JudgeDriftMonitor;
  tracer: Tracer;
  /** Independent timestamp authority (separate keys) for trusted-time anchoring. */
  tsa: TsaProvider;
  /** Published TSA public keyset (local provider); empty for rfc3161 (tokens self-verify). */
  tsaKeyset: () => Promise<PublicKeyEntry[]>;
  /** Anchor a tenant's current chain head with a trusted timestamp. */
  anchorHead: (tenantId: string) => Promise<{ sequence: number; headHash: string } | null>;
  /** Scheduled per-tenant anchoring (default hourly); started by the server entrypoint. */
  anchorScheduler: AnchorScheduler;
  tenants: TenantStorePort;
  apiKeys: ApiKeyStorePort;
  accessAudit: AccessAuditLogPort;
  mandates: MandateStorePort;
  escalations: EscalationStorePort;
  notifier: ReviewNotifierPort;
  reviewSla: ReviewSlaService;
  oidc: OidcVerifier;
  close: () => Promise<void>;
}

export interface BuildPlatformOptions {
  /** Override OIDC issuer configs (tests inject local JWKS issuers). */
  oidcIssuers?: OidcIssuerConfig[];
  /** Injected only by startup tests; production uses the hash-verifying ONNX loader. */
  loadJudge?: JudgeLoader;
}

export type { JudgeLoader };

/** The concerns a production deployment must serve: every model in `models/manifest.json`. */
export const PRODUCTION_JUDGE_CONCERNS: readonly string[] = servedConcerns();

/**
 * Build the active judge registry before the API opens a listener, through the judge-provider
 * registry (`PHAROS_JUDGE_PROVIDER` names the backend). Production is already fail-closed to
 * `onnx` by configuration; the ONNX provider additionally downloads or reads every
 * content-addressed artifact, verifies its manifest digest, creates every inference session,
 * and refuses startup if any concern is unavailable.
 */
export async function buildJudgeRegistry(
  config: PharosConfig,
  loadJudge?: JudgeLoader,
): Promise<ModelRegistry> {
  if (config.env === "prod" && config.judge.provider === "onnx") {
    assertQualifiedOnnxRuntime(loadManifest());
  }
  return createJudgeRegistry(config.judge.provider, {
    concerns: PRODUCTION_JUDGE_CONCERNS,
    cacheDir: config.judge.modelDir,
    loadJudge,
  });
}

/** The evidence-chain signer, built by name from the signing-provider registry. */
export function buildSigner(config: PharosConfig): SigningProvider {
  return createSigningProvider(config.kms.provider, {
    settings: config.kms,
    namespace: "signing",
  });
}

/**
 * The signer for the simulated (`local`) TSA: the same backend as the evidence signer but an
 * INDEPENDENT key namespace, so anchors never trust the evidence keys.
 */
export function buildTsaSigner(config: PharosConfig): SigningProvider {
  return createSigningProvider(config.kms.provider, { settings: config.kms, namespace: "tsa" });
}

/**
 * Build the trusted-time authority by name from the TSA-provider registry. `rfc3161` is a real
 * TSA whose tokens self-verify (no keyset is published); `local` is the simulated TSA whose
 * public keyset IS published for offline verification.
 */
export function buildTsaProvider(config: PharosConfig): {
  tsa: TsaProvider;
  keyset: () => Promise<PublicKeyEntry[]>;
} {
  return createTsaProvider(config.tsa.provider, {
    settings: config.tsa,
    env: config.env,
    localSigner: () => buildTsaSigner(config),
  });
}

/** Per-queue notification channels (Sprint 4 policy); shared by every backend. */
const REVIEW_NOTIFIER_OPTIONS: ReviewNotifierOptions = {
  queuePolicy: {
    "treasury-control": ["email", "slack"],
    "privacy-office": ["email"],
    "registered-principal": ["email", "teams"],
  },
  defaultChannels: ["email"],
};

/**
 * Build the storage backend from configuration — the single selection point, so the routes
 * never know which backend they run on. `postgres` is the default and the production path
 * (`loadConfig` refuses anything else in prod); `embedded` is the on-ramp.
 */
export async function buildStorage(
  config: PharosConfig,
  signer: SigningProvider,
): Promise<StorageBackend> {
  // Per-tenant signing keys (matches TenantStore.kmsKeyName).
  const resolveKeyName = (tenantId: string) => `tenant:${tenantId}`;
  // Selected by name through the storage-backend registry, like every other provider. The
  // shipped backends validate their own required settings; loadConfig has already asserted
  // the postgres ones and refused embedded in production.
  return createStorageBackend(config.storage.backend, {
    settings: {
      pgUrl: config.pg.url,
      redisUrl: config.redis.url,
      s3:
        config.s3.endpoint && config.s3.region && config.s3.bucket
          ? {
              endpoint: config.s3.endpoint,
              region: config.s3.region,
              bucket: config.s3.bucket,
              accessKey: config.s3.accessKey,
              secretKey: config.s3.secretKey,
              forcePathStyle: config.s3.forcePathStyle,
              retentionDays: config.s3.wormRetentionDays,
            }
          : undefined,
      dataDir: config.storage.dataDir,
    },
    signer,
    resolveKeyName,
    notifier: REVIEW_NOTIFIER_OPTIONS,
  });
}

export async function buildPlatform(
  config: PharosConfig = loadConfig(),
  options: BuildPlatformOptions = {},
): Promise<Platform> {
  const metrics = new MetricsRegistry();
  // Wrap the seal-path signer with a circuit breaker: a KMS outage must fail the seal (and
  // therefore the whole govern-and-record transaction) rather than queue a "sign later" —
  // no verdict without a durable record. Surfaced as KmsUnavailableError -> 503 by the API.
  const signer = new ResilientSigner(buildSigner(config), {
    onKmsUnavailable: () => metrics.kmsUnavailable.inc(),
  });
  const { tsa, keyset: tsaKeyset } = buildTsaProvider(config);

  const storage = await buildStorage(config, signer);
  const { store, tenants, apiKeys, accessAudit, mandates, escalations, notifier } = storage;
  const { evidenceOps, policyStore, assurance, counters: cache } = storage;
  const engine = new VerdictEngine({ deadlineMs: config.api.verdictDeadlineMs });
  // Preload and verify the complete configured model set before the service can become healthy.
  // A partial production judge fleet is a startup failure, never a silent fallback to linear.
  const registry = await buildJudgeRegistry(config, options.loadJudge);
  const driftProfile = config.judge.driftProfilePath
    ? loadJudgeDriftProfile(config.judge.driftProfilePath)
    : null;
  const judgeDrift = new JudgeDriftMonitor(metrics, driftProfile);
  if (config.env === "prod") {
    judgeDrift.assertModelsConfigured(
      PRODUCTION_JUDGE_CONCERNS.map((concern) => ({
        concern,
        judgeVersion: registry.activeVersion(concern)!,
      })),
    );
  }
  const shippedArtifacts = artifactsOf(SHIPPED_PACKS);
  const cascade = new VerdictCascade({
    engine,
    registry,
    deadlineMs: config.api.verdictDeadlineMs,
    packs: DEFAULT_PACK_BINDINGS,
    routing: config.judge.routing,
    structural: config.judge.structural,
    policyArtifacts: shippedArtifacts, // citation-level rules by default; per-call override adds tenant policies
    onJudgeResults: (results) => {
      for (const result of results) {
        try {
          judgeDrift.observe(result);
        } catch (err) {
          // Monitoring must fail visible, but it must never convert a valid policy decision into
          // an unsealed 500. Exact profile coverage is enforced synchronously at production boot.
          metrics.errors.inc({ route: "judge_monitoring" });
          console.error("[judge-monitoring] observation rejected:", (err as Error).message);
        }
      }
    },
  });
  const tracer = new Tracer();
  const activePolicyArtifacts = async (tenantId: string): Promise<PolicyArtifact[]> => [
    ...shippedArtifacts,
    ...((await policyStore.getActiveArtifacts(tenantId)) as PolicyArtifact[]),
  ];
  const reviewSla = new ReviewSlaService({ tenants, escalations, notifier });

  const integrity = new ChainIntegrityService({
    store,
    signer,
    // Surface missing/stale trusted-time anchors as non-fatal chainIntegrity warnings.
    listAnchors: (tenantId) => evidenceOps.listAnchors(tenantId),
    anchorMaxAgeMs: config.tsa.intervalMs > 0 ? config.tsa.intervalMs * 2 : undefined,
    onBreak: (report) => {
      // Structured alert, consumed by the observability/alerting stack.
      console.error("[chain-integrity] BREAK detected", JSON.stringify(report.errors));
    },
  });

  const anchorHead = async (tenantId: string) => {
    const head = await store.getHead(tenantId);
    if (!head) return null;
    const ts = await tsa.timestamp(head.hash);
    await evidenceOps.createAnchor({
      id: randomUUID(),
      tenantId,
      sequence: head.sequence,
      headHash: head.hash,
      provider: ts.provider ?? "local",
      tsaTime: ts.time,
      tsaSignature: ts.signature ?? null,
      tsaKeyId: ts.keyId ?? null,
      tsaToken: ts.token ?? null,
    });
    return { sequence: head.sequence, headHash: head.hash };
  };

  const anchorScheduler = new AnchorScheduler({
    listTenants: () => store.listTenants(),
    anchorTenant: anchorHead,
    onError: (tenantId, err) =>
      console.error(`[anchor-scheduler] failed for ${tenantId}:`, (err as Error).message),
  });

  const oidcIssuers = options.oidcIssuers ?? (config.oidc as OidcIssuerConfig[]);
  const oidc = new OidcVerifier(oidcIssuers);

  return {
    config,
    storage,
    ...("pool" in storage ? { pool: (storage as { pool: Pool }).pool } : {}),
    signer,
    cache,
    store,
    engine,
    registry,
    cascade,
    integrity,
    evidenceOps,
    policyStore,
    assurance,
    activePolicyArtifacts,
    metrics,
    judgeDrift,
    tracer,
    tsa,
    tsaKeyset,
    anchorHead,
    anchorScheduler,
    tenants,
    apiKeys,
    accessAudit,
    mandates,
    escalations,
    notifier,
    reviewSla,
    oidc,
    close: async () => {
      integrity.stop();
      anchorScheduler.stop();
      reviewSla.stop();
      await storage.close();
    },
  };
}
