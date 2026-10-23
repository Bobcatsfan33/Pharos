import { randomUUID } from "node:crypto";
import { loadConfig, type PharosConfig } from "@pharos/config";
import {
  FileKeystore,
  LocalKms,
  ResilientSigner,
  VerdictEngine,
  type SigningProvider,
  type PublicKeyEntry,
} from "@pharos/core";
import { LocalTsa, Rfc3161Tsa, type TsaProvider } from "@pharos/evidence";
import {
  AnchorScheduler,
  ChainIntegrityService,
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
  loadDefaultRegistry,
  loadOnnxJudge,
  loadManifest,
  assertQualifiedOnnxRuntime,
  ModelRegistry,
  type AsyncJudge,
  type LoadOnnxOptions,
} from "@pharos/judge";
import { VerdictCascade, DEFAULT_PACK_BINDINGS } from "@pharos/cascade";
import { SHIPPED_PACKS, type PolicyArtifact } from "@pharos/policy";
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
  /**
   * The shipped policy packs every tenant is evaluated against (default: all of
   * `SHIPPED_PACKS`). The CLI passes the project's selection — the regulation packs' judges
   * are tuned for communications and payments and over-flag shell commands.
   */
  policyPacks?: PolicyArtifact[];
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
  if (config.env === "prod") assertQualifiedOnnxRuntime(loadManifest());

  // Fetch, digest-verify, create the inference sessions, and warm all required packs
  // concurrently. Startup remains all-or-nothing: nothing is registered until every
  // load has succeeded and every returned identity has been validated.
  const judges = await Promise.all(
    PRODUCTION_JUDGE_CONCERNS.map(async (concern) => {
      const judge = await loadJudge({
        concern,
        packId: concern,
        cacheDir: config.judge.modelDir,
      });
      // Exercise the actual inference path before the readiness listener can open.
      await judge.scoreBatch([""]);
      return judge;
    }),
  );
  const registry = new ModelRegistry();
  for (const [index, concern] of PRODUCTION_JUDGE_CONCERNS.entries()) {
    const judge = judges[index]!;
    if (judge.packId !== concern || judge.concern !== concern) {
      throw new Error(
        `judge loader returned ${judge.packId}/${judge.concern} for required concern ${concern}`,
      );
    }
    registry.registerServed(judge);
  }
  return registry;
}

/**
 * Provider modules that pull cloud SDKs are imported lazily so a build that only runs the
 * embedded on-ramp (the CLI bundle) never loads pg, ioredis, or the AWS SDKs.
 */
async function awsKmsModule() {
  return import("@pharos/core/signing/awsKms");
}

export async function buildSigner(config: PharosConfig): Promise<SigningProvider> {
  if (config.kms.provider === "aws-kms") {
    const { AwsKms } = await awsKmsModule();
    return new AwsKms({
      region: config.kms.awsRegion,
      endpoint: config.kms.awsEndpoint,
      aliasPrefix: "pharos",
      allowKeyCreation: config.kms.awsAllowKeyCreation,
    });
  }
  if (!config.kms.keystorePassphrase) {
    throw new Error("local-kms requires an encrypted-keystore passphrase");
  }
  return new LocalKms(new FileKeystore(config.kms.keystoreDir, config.kms.keystorePassphrase));
}

/** The timestamp authority uses an INDEPENDENT keystore so anchors don't trust platform keys. */
/** The signing provider for the simulated (`local`) TSA — an INDEPENDENT keystore/namespace. */
export async function buildTsaSigner(config: PharosConfig): Promise<SigningProvider> {
  if (config.kms.provider === "aws-kms") {
    const { AwsKms } = await awsKmsModule();
    // Separate alias namespace so the TSA keyset is isolated from the signing keyset.
    return new AwsKms({
      region: config.kms.awsRegion,
      endpoint: config.kms.awsEndpoint,
      aliasPrefix: "pharos-tsa",
      allowKeyCreation: config.kms.awsAllowKeyCreation,
    });
  }
  if (!config.kms.keystorePassphrase) {
    throw new Error("local TSA requires an encrypted-keystore passphrase");
  }
  return new LocalKms(
    new FileKeystore(`${config.kms.keystoreDir}-tsa`, config.kms.keystorePassphrase),
  );
}

/** Dev default TSA when PHAROS_TSA_PROVIDER=rfc3161 but no URL is set (FreeTSA). */
const DEFAULT_FREETSA_URL = "https://freetsa.org/tsr";

/**
 * Build the trusted-time authority. `rfc3161` is a real TSA (the token is verified offline
 * against its own certificate, so no keyset is published). `local` is the simulated TSA whose
 * public keyset IS published for offline verification.
 */
export async function buildTsaProvider(config: PharosConfig): Promise<{
  tsa: TsaProvider;
  keyset: () => Promise<PublicKeyEntry[]>;
}> {
  if (config.tsa.provider === "rfc3161") {
    return {
      tsa: new Rfc3161Tsa(config.tsa.url ?? DEFAULT_FREETSA_URL, {
        trustPolicy: { trustedCertSha256: config.tsa.trustedCertSha256 },
      }),
      keyset: async () => [],
    };
  }
  const signer = await buildTsaSigner(config);
  return { tsa: new LocalTsa(signer, `tsa-${config.env}`), keyset: () => signer.publishKeyset() };
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
  // Sprint 1: per-tenant signing keys (matches TenantStore.kmsKeyName).
  const resolveKeyName = (tenantId: string) => `tenant:${tenantId}`;
  if (config.storage.backend === "embedded") {
    const { buildEmbeddedStorage } = await import("@pharos/storage/embedded");
    return buildEmbeddedStorage(
      { dataDir: config.storage.dataDir },
      { signer, resolveKeyName, notifier: REVIEW_NOTIFIER_OPTIONS },
    );
  }
  // loadConfig guarantees these for the postgres backend; the fallbacks only satisfy types.
  const { buildPostgresStorage } = await import("@pharos/storage/postgres");
  return buildPostgresStorage(
    {
      pgUrl: config.pg.url ?? "",
      redisUrl: config.redis.url ?? "",
      s3: {
        endpoint: config.s3.endpoint ?? "",
        region: config.s3.region ?? "",
        bucket: config.s3.bucket ?? "",
        accessKey: config.s3.accessKey,
        secretKey: config.s3.secretKey,
        forcePathStyle: config.s3.forcePathStyle,
        retentionDays: config.s3.wormRetentionDays,
      },
    },
    { signer, resolveKeyName, notifier: REVIEW_NOTIFIER_OPTIONS },
  );
}

export async function buildPlatform(
  config: PharosConfig = loadConfig(),
  options: BuildPlatformOptions = {},
): Promise<Platform> {
  const metrics = new MetricsRegistry();
  // Wrap the seal-path signer with a circuit breaker: a KMS outage must fail the seal (and
  // therefore the whole govern-and-record transaction) rather than queue a "sign later" —
  // no verdict without a durable record. Surfaced as KmsUnavailableError -> 503 by the API.
  const signer = new ResilientSigner(await buildSigner(config), {
    onKmsUnavailable: () => metrics.kmsUnavailable.inc(),
  });
  const { tsa, keyset: tsaKeyset } = await buildTsaProvider(config);

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
  const shippedArtifacts = options.policyPacks ?? Object.values(SHIPPED_PACKS);
  const cascade = new VerdictCascade({
    engine,
    registry,
    deadlineMs: config.api.verdictDeadlineMs,
    packs: DEFAULT_PACK_BINDINGS,
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
