import { randomUUID } from "node:crypto";
import { loadConfig, type PharosConfig } from "@pharos/config";
import {
  AwsKms,
  FileKeystore,
  LocalKms,
  ResilientSigner,
  VerdictEngine,
  type SigningProvider,
  type PublicKeyEntry,
} from "@pharos/core";
import { LocalTsa, Rfc3161Tsa, type TsaProvider } from "@pharos/evidence";
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
  loadDefaultRegistry,
  loadOnnxJudge,
  ModelRegistry,
  type AsyncJudge,
  type LoadOnnxOptions,
} from "@pharos/judge";
import { VerdictCascade, DEFAULT_PACK_BINDINGS } from "@pharos/cascade";
import { SHIPPED_PACKS, type PolicyArtifact } from "@pharos/policy";
import { MetricsRegistry, Tracer } from "@pharos/observability";
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

export type JudgeLoader = (options: LoadOnnxOptions) => Promise<AsyncJudge>;

export const PRODUCTION_JUDGE_CONCERNS = [
  "finra-promissory",
  "phi-in-context",
  "funds-movement-intent",
] as const;

/**
 * Build the active judge registry before the API opens a listener.
 *
 * Production configuration is already fail-closed to `onnx`; this composition
 * step additionally downloads or reads every content-addressed artifact,
 * verifies its manifest digest, creates every inference session, and refuses
 * startup if any concern is unavailable. Local development retains the honest,
 * measured linear baseline.
 */
export async function buildJudgeRegistry(
  config: PharosConfig,
  loadJudge: JudgeLoader = loadOnnxJudge,
): Promise<ModelRegistry> {
  if (config.judge.provider === "linear") return loadDefaultRegistry();

  const registry = new ModelRegistry();
  for (const concern of PRODUCTION_JUDGE_CONCERNS) {
    const judge = await loadJudge({
      concern,
      packId: concern,
      cacheDir: config.judge.modelDir,
    });
    if (judge.packId !== concern || judge.concern !== concern) {
      throw new Error(
        `judge loader returned ${judge.packId}/${judge.concern} for required concern ${concern}`,
      );
    }
    registry.registerServed(judge);
  }
  return registry;
}

export function buildSigner(config: PharosConfig): SigningProvider {
  if (config.kms.provider === "aws-kms") {
    return new AwsKms({
      region: config.kms.awsRegion,
      endpoint: config.kms.awsEndpoint,
      aliasPrefix: "pharos",
    });
  }
  return new LocalKms(new FileKeystore(config.kms.keystoreDir));
}

/** The timestamp authority uses an INDEPENDENT keystore so anchors don't trust platform keys. */
/** The signing provider for the simulated (`local`) TSA — an INDEPENDENT keystore/namespace. */
export function buildTsaSigner(config: PharosConfig): SigningProvider {
  if (config.kms.provider === "aws-kms") {
    // Separate alias namespace so the TSA keyset is isolated from the signing keyset.
    return new AwsKms({
      region: config.kms.awsRegion,
      endpoint: config.kms.awsEndpoint,
      aliasPrefix: "pharos-tsa",
    });
  }
  return new LocalKms(new FileKeystore(`${config.kms.keystoreDir}-tsa`));
}

/** Dev default TSA when PHAROS_TSA_PROVIDER=rfc3161 but no URL is set (FreeTSA). */
const DEFAULT_FREETSA_URL = "https://freetsa.org/tsr";

/**
 * Build the trusted-time authority. `rfc3161` is a real TSA (the token is verified offline
 * against its own certificate, so no keyset is published). `local` is the simulated TSA whose
 * public keyset IS published for offline verification.
 */
export function buildTsaProvider(config: PharosConfig): {
  tsa: TsaProvider;
  keyset: () => Promise<PublicKeyEntry[]>;
} {
  if (config.tsa.provider === "rfc3161") {
    return {
      tsa: new Rfc3161Tsa(config.tsa.url ?? DEFAULT_FREETSA_URL, {
        trustPolicy: { trustedCertSha256: config.tsa.trustedCertSha256 },
      }),
      keyset: async () => [],
    };
  }
  const signer = buildTsaSigner(config);
  return { tsa: new LocalTsa(signer, `tsa-${config.env}`), keyset: () => signer.publishKeyset() };
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

  // Sprint 1: per-tenant signing keys (matches TenantStore.kmsKeyName).
  const resolveKeyName = (tenantId: string) => `tenant:${tenantId}`;

  const store = new EvidenceStore({ pool, worm, signer, resolveKeyName });
  const engine = new VerdictEngine({ deadlineMs: config.api.verdictDeadlineMs });
  // Preload and verify the complete configured model set before the service can become healthy.
  // A partial production judge fleet is a startup failure, never a silent fallback to linear.
  const registry = await buildJudgeRegistry(config, options.loadJudge);
  const shippedArtifacts = Object.values(SHIPPED_PACKS);
  const cascade = new VerdictCascade({
    engine,
    registry,
    deadlineMs: config.api.verdictDeadlineMs,
    packs: DEFAULT_PACK_BINDINGS,
    policyArtifacts: shippedArtifacts, // citation-level rules by default; per-call override adds tenant policies
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
      // Structured alert; Sprint 8 wires this into the observability/alerting stack.
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
