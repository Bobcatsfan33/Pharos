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
  AccessAuditLog,
  AnchorScheduler,
  ApiKeyStore,
  AssuranceStore,
  ChainIntegrityService,
  EscalationStore,
  EvidenceOpsStore,
  EvidenceStore,
  MandateStore,
  PolicyStore,
  ReviewNotifier,
  TenantStore,
  VerdictCache,
  WormStore,
  createPool,
  runMigrations,
  type Pool,
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
  evidenceOps: EvidenceOpsStore;
  policyStore: PolicyStore;
  assurance: AssuranceStore;
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
  tenants: TenantStore;
  apiKeys: ApiKeyStore;
  accessAudit: AccessAuditLog;
  mandates: MandateStore;
  escalations: EscalationStore;
  notifier: ReviewNotifier;
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

export async function buildPlatform(
  config: PharosConfig = loadConfig(),
  options: BuildPlatformOptions = {},
): Promise<Platform> {
  const pool = createPool(config.pg.url);
  await runMigrations(pool);

  const metrics = new MetricsRegistry();
  // Wrap the seal-path signer with a circuit breaker: a KMS outage must fail the seal (and
  // therefore the whole govern-and-record transaction) rather than queue a "sign later" —
  // no verdict without a durable record. Surfaced as KmsUnavailableError -> 503 by the API.
  const signer = new ResilientSigner(buildSigner(config), {
    onKmsUnavailable: () => metrics.kmsUnavailable.inc(),
  });
  const { tsa, keyset: tsaKeyset } = buildTsaProvider(config);

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

  // Per-tenant signing keys (matches TenantStore.kmsKeyName).
  const resolveKeyName = (tenantId: string) => `tenant:${tenantId}`;

  const store = new EvidenceStore({ pool, worm, signer, resolveKeyName });
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
  const policyStore = new PolicyStore(pool);
  const assurance = new AssuranceStore(pool);
  const tracer = new Tracer();
  const activePolicyArtifacts = async (tenantId: string): Promise<PolicyArtifact[]> => [
    ...shippedArtifacts,
    ...((await policyStore.getActiveArtifacts(tenantId)) as PolicyArtifact[]),
  ];
  const tenants = new TenantStore(pool);
  const apiKeys = new ApiKeyStore(pool);
  const accessAudit = new AccessAuditLog(pool);
  const mandates = new MandateStore(pool);
  const escalations = new EscalationStore(pool);
  const notifier = new ReviewNotifier(pool, {
    queuePolicy: {
      "treasury-control": ["email", "slack"],
      "privacy-office": ["email"],
      "registered-principal": ["email", "teams"],
    },
    defaultChannels: ["email"],
  });
  const reviewSla = new ReviewSlaService({ tenants, escalations, notifier });
  const evidenceOps = new EvidenceOpsStore(pool);

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
    pool,
    signer,
    worm,
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
      await cache.close().catch(() => {});
      await pool.end();
    },
  };
}
