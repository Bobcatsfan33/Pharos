/**
 * Storage ports.
 *
 * Every store the platform wires is described here as an interface, so the composition
 * root (`services/api/src/platform.ts`) and the routes depend on *what a store does*, not
 * on Postgres. The Postgres classes in this package implement these ports and remain the
 * production path; a second backend (embedded SQLite + local files, for the zero-Docker
 * on-ramp) implements the same ports and runs the same conformance suite.
 *
 * Adding a method to a Postgres class does not change behaviour; adding it here is a
 * contract change every backend must satisfy. Keep the ports to what callers actually use.
 */
import type { ActionRecord, MandateBinding } from "@pharos/core";
import type { Permission } from "@pharos/identity";
import type { AppendInput, RecordDisclosure } from "./evidenceStore.js";
import type { WormReconciliation } from "./wormStore.js";
import type { Tenant, TenantStatus } from "./tenantStore.js";
import type { ApiKeyRecord, VerifiedApiKey } from "./apiKeyStore.js";
import type { AccessAction, AccessAuditEntry, AccessAuditVerification } from "./accessAudit.js";
import type { Escalation, EscalationStatus, ResolutionDecision } from "./escalationStore.js";
import type { NotificationChannel, NotificationEvent, NotificationRecord } from "./notifier.js";
import type { ChainAnchor, ClaimsPackRow, LegalHold } from "./evidenceOpsStore.js";
import type { PolicyStatus, PolicyVersion } from "./policyStore.js";
import type { AssuranceAudit, AssuranceStats } from "./assuranceStore.js";

/** Result of reconciling committed records against the evidence copies that exist. */
export type EvidenceReconciliation = WormReconciliation;

/** The transactional write path plus the reads the API and verifiers need. */
export interface EvidenceStorePort {
  /**
   * Seal and durably record a governed action, allocating the next per-tenant sequence and
   * linking to the prior head, in ONE transaction. Verdict and evidence commit together or
   * not at all — this is the invariant every backend must keep.
   */
  append(input: AppendInput): Promise<ActionRecord>;
  getRecord(tenantId: string, sequence: number): Promise<ActionRecord | null>;
  getRecordById(tenantId: string, id: string): Promise<ActionRecord | null>;
  findByIdempotencyKey(
    tenantId: string,
    key: string,
    requestFingerprint: string,
  ): Promise<ActionRecord | null>;
  /** Full per-tenant chain ordered by ascending sequence (genesis -> head). */
  getChain(tenantId: string): Promise<ActionRecord[]>;
  getRange(tenantId: string, fromSequence: number, toSequence: number): Promise<RecordDisclosure[]>;
  getHead(tenantId: string): Promise<{ sequence: number; hash: string } | null>;
  listTenants(): Promise<string[]>;
  countInPeriod(tenantId: string, fromIso?: string, toIso?: string): Promise<number>;
  count(tenantId: string): Promise<number>;
  /** Compare committed records against the evidence copies present in the evidence tier. */
  reconcileEvidence(tenantId: string): Promise<EvidenceReconciliation>;
}

export interface TenantStorePort {
  createTenant(input: {
    tenantId: string;
    displayName: string;
    retainEvidenceOnDelete?: boolean;
  }): Promise<Tenant>;
  getTenant(tenantId: string): Promise<Tenant | null>;
  setStatus(tenantId: string, status: TenantStatus): Promise<void>;
  listTenants(): Promise<Tenant[]>;
  deleteTenant(tenantId: string): Promise<{ evidenceRetained: boolean }>;
}

export interface ApiKeyStorePort {
  create(
    tenantId: string,
    name: string,
    scopes: Permission[],
  ): Promise<{ record: ApiKeyRecord; plaintext: string }>;
  verify(plaintext: string): Promise<VerifiedApiKey | null>;
  rotate(
    tenantId: string,
    oldKeyId: string,
  ): Promise<{ record: ApiKeyRecord; plaintext: string } | null>;
  revoke(tenantId: string, keyId: string): Promise<void>;
  list(tenantId: string): Promise<ApiKeyRecord[]>;
}

export interface AccessAuditLogPort {
  record(input: {
    tenantId: string;
    actor: string;
    actorKind: string;
    action: AccessAction;
    resource: string;
    metadata?: Record<string, unknown>;
  }): Promise<AccessAuditEntry>;
  list(tenantId: string): Promise<AccessAuditEntry[]>;
  verify(tenantId: string): Promise<AccessAuditVerification>;
}

export interface MandateStorePort {
  create(input: {
    tenantId: string;
    mandateId: string;
    scope: string;
    limits?: Record<string, unknown>;
    grantor: string;
    expiresAt?: string | null;
  }): Promise<MandateBinding>;
  getActive(tenantId: string, mandateId: string): Promise<MandateBinding | null>;
  list(tenantId: string): Promise<MandateBinding[]>;
  revoke(tenantId: string, mandateId: string): Promise<void>;
}

export interface EscalationStorePort {
  create(input: {
    tenantId: string;
    recordSequence: number;
    context: Record<string, unknown>;
    idempotencyKey: string;
    queue?: string;
    priority?: number;
    slaDueAt?: string | null;
    fourEyes?: boolean;
  }): Promise<Escalation>;
  assign(tenantId: string, id: string, reviewer: string): Promise<Escalation | null>;
  listByQueue(tenantId: string, queue: string): Promise<Escalation[]>;
  listResolved(tenantId: string, limit?: number): Promise<Escalation[]>;
  queueDepths(tenantId: string): Promise<Record<string, number>>;
  findNewBreaches(tenantId: string, nowIso: string): Promise<Escalation[]>;
  get(tenantId: string, id: string): Promise<Escalation | null>;
  getByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<Escalation | null>;
  listPending(tenantId: string): Promise<Escalation[]>;
  resolve(
    tenantId: string,
    id: string,
    input: {
      decision: ResolutionDecision;
      rationale: string;
      resolvedBy: string;
      modifiedAction?: unknown;
    },
  ): Promise<Escalation | null>;
  claimResume(tenantId: string, id: string, claimId?: string): Promise<Escalation | null>;
}

export interface ReviewNotifierPort {
  fire(input: {
    tenantId: string;
    event: NotificationEvent;
    escalationId?: string | null;
    queue?: string | null;
  }): Promise<NotificationChannel[]>;
  count(tenantId: string, event: NotificationEvent): Promise<number>;
  list(tenantId: string, limit?: number): Promise<NotificationRecord[]>;
}

export interface EvidenceOpsStorePort {
  createHold(input: {
    tenantId: string;
    name: string;
    reason?: string;
    fromSequence?: number;
    toSequence?: number;
    createdBy?: string;
  }): Promise<LegalHold>;
  listHolds(tenantId: string): Promise<LegalHold[]>;
  releaseHold(tenantId: string, id: string): Promise<void>;
  isUnderHold(tenantId: string, sequence: number): Promise<boolean>;
  createAnchor(input: ChainAnchor): Promise<void>;
  listAnchors(tenantId: string): Promise<ChainAnchor[]>;
  createPack(input: {
    tenantId: string;
    incident?: string;
    audience: string;
    fromSequence: number;
    toSequence: number;
    redactFields?: string[];
  }): Promise<ClaimsPackRow>;
  sealPack(tenantId: string, id: string, bundle: unknown): Promise<ClaimsPackRow | null>;
  releasePack(tenantId: string, id: string, releasedTo: string): Promise<ClaimsPackRow | null>;
  getPack(tenantId: string, id: string): Promise<ClaimsPackRow | null>;
  listPacks(tenantId: string): Promise<ClaimsPackRow[]>;
}

export interface PolicyStorePort {
  createDraft(input: {
    tenantId: string;
    name: string;
    artifact: unknown;
    sourceText?: string;
    changelog?: string;
  }): Promise<PolicyVersion>;
  get(tenantId: string, id: string): Promise<PolicyVersion | null>;
  list(tenantId: string): Promise<PolicyVersion[]>;
  setStatus(tenantId: string, id: string, status: PolicyStatus): Promise<PolicyVersion | null>;
  activate(tenantId: string, id: string): Promise<PolicyVersion | null>;
  rollback(
    tenantId: string,
    name: string,
  ): Promise<{ rolledBack: PolicyVersion | null; restored: PolicyVersion | null }>;
  getActiveArtifacts(tenantId: string): Promise<unknown[]>;
  getShadowArtifacts(tenantId: string): Promise<unknown[]>;
}

export interface AssuranceStorePort {
  sample(
    tenantId: string,
    candidates: Array<{ recordSequence: number; pack: string | null; decision: string }>,
  ): Promise<number>;
  listPending(tenantId: string, limit?: number): Promise<AssuranceAudit[]>;
  recordAudit(tenantId: string, id: string, upheld: boolean, auditedBy: string): Promise<void>;
  stats(tenantId: string, pack?: string): Promise<AssuranceStats>;
  statsByPack(tenantId: string): Promise<Record<string, AssuranceStats>>;
  grantException(tenantId: string, checkId: string, owner: string, reason?: string): Promise<void>;
  revokeException(tenantId: string, checkId: string): Promise<void>;
  exceptions(tenantId: string): Promise<Record<string, string>>;
}

/**
 * Fixed-window counters for rate limiting plus a liveness probe. Redis in production so
 * limits hold across API instances; a backend that keeps these in process memory must say
 * so in its posture (`multiInstanceRateLimits: false`).
 */
export interface CounterStorePort {
  connect(): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * What a storage backend actually guarantees, stated so every surface (CLI, /healthz,
 * docs) can label it honestly instead of inheriting the production path's claims.
 */
export interface EvidencePosture {
  backend: "postgres" | "embedded";
  /** How sealed evidence copies are protected from overwrite and deletion. */
  immutability: "s3-object-lock-compliance" | "tamper-evident-local-files";
  /** True only when the evidence tier enforces write-once retention independently of Pharos. */
  worm: boolean;
  /** True when a database-level row-security backstop confines tenant reads and writes. */
  rowLevelSecurity: boolean;
  /** True when rate-limit counters are shared across API instances. */
  multiInstanceRateLimits: boolean;
  /** One sentence a human can read. Must not overclaim. */
  description: string;
}

/** Everything `buildPlatform` needs from a storage backend. */
export interface StorageBackend {
  readonly posture: EvidencePosture;
  readonly store: EvidenceStorePort;
  readonly tenants: TenantStorePort;
  readonly apiKeys: ApiKeyStorePort;
  readonly accessAudit: AccessAuditLogPort;
  readonly mandates: MandateStorePort;
  readonly escalations: EscalationStorePort;
  readonly notifier: ReviewNotifierPort;
  readonly evidenceOps: EvidenceOpsStorePort;
  readonly policyStore: PolicyStorePort;
  readonly assurance: AssuranceStorePort;
  readonly counters: CounterStorePort;
  /** Release connections / file handles. Idempotent. */
  close(): Promise<void>;
}

export type { EscalationStatus };
