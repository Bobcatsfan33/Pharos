import { randomUUID } from "node:crypto";
import { loadConfig, type PharosConfig } from "@pharos/config";
import {
  FileKeystore,
  LocalKms,
  VerdictEngine,
  type SigningProvider,
} from "@pharos/core";
import { createTimestamp } from "@pharos/evidence";
import {
  AccessAuditLog,
  ApiKeyStore,
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
import { loadDefaultRegistry, type ModelRegistry } from "@pharos/judge";
import { VerdictCascade, DEFAULT_PACK_BINDINGS } from "@pharos/cascade";
import { SHIPPED_PACKS, type PolicyArtifact } from "@pharos/policy";
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
  /** Active policy artifacts for a tenant (shipped packs + active custom policies). */
  activePolicyArtifacts: (tenantId: string) => Promise<PolicyArtifact[]>;
  /** Independent timestamp authority (separate keys) for trusted-time anchoring. */
  tsa: SigningProvider;
  /** Anchor a tenant's current chain head with a trusted timestamp. */
  anchorHead: (tenantId: string) => Promise<{ sequence: number; headHash: string } | null>;
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
}

export function buildSigner(config: PharosConfig): SigningProvider {
  if (config.kms.provider === "local-kms") {
    return new LocalKms(new FileKeystore(config.kms.keystoreDir));
  }
  // aws-kms wiring is introduced in a later sprint; fail explicitly until then.
  throw new Error(`KMS provider not yet supported: ${config.kms.provider}`);
}

/** The timestamp authority uses an INDEPENDENT keystore so anchors don't trust platform keys. */
export function buildTsa(config: PharosConfig): SigningProvider {
  if (config.kms.provider === "local-kms") {
    return new LocalKms(new FileKeystore(`${config.kms.keystoreDir}-tsa`));
  }
  throw new Error(`KMS provider not yet supported: ${config.kms.provider}`);
}

export async function buildPlatform(
  config: PharosConfig = loadConfig(),
  options: BuildPlatformOptions = {},
): Promise<Platform> {
  const pool = createPool(config.pg.url);
  await runMigrations(pool);

  const signer = buildSigner(config);
  const tsa = buildTsa(config);

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
  const shippedArtifacts = Object.values(SHIPPED_PACKS);
  const cascade = new VerdictCascade({
    engine,
    registry,
    deadlineMs: config.api.verdictDeadlineMs,
    packs: DEFAULT_PACK_BINDINGS,
    policyArtifacts: shippedArtifacts, // citation-level rules by default; per-call override adds tenant policies
  });
  const policyStore = new PolicyStore(pool);
  const activePolicyArtifacts = async (tenantId: string): Promise<PolicyArtifact[]> => [
    ...shippedArtifacts,
    ...((await policyStore.getActiveArtifacts(tenantId)) as PolicyArtifact[]),
  ];
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

  const anchorHead = async (tenantId: string) => {
    const head = await store.getHead(tenantId);
    if (!head) return null;
    const time = new Date().toISOString();
    const ts = await createTimestamp(tsa, `tsa-${config.env}`, head.hash, time);
    await evidenceOps.createAnchor({
      id: randomUUID(),
      tenantId,
      sequence: head.sequence,
      headHash: head.hash,
      tsaTime: ts.time,
      tsaSignature: ts.signature,
      tsaKeyId: ts.keyId,
    });
    return { sequence: head.sequence, headHash: head.hash };
  };
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
    activePolicyArtifacts,
    tsa,
    anchorHead,
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
      reviewSla.stop();
      await cache.close().catch(() => {});
      await pool.end();
    },
  };
}
