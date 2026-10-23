import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SigningProvider } from "@pharos/core";
import type { ReviewNotifierOptions } from "../notifier.js";
import type { EvidencePosture, StorageBackend } from "../ports.js";
import { EmbeddedDb, runEmbeddedMigrations } from "./sqlite.js";
import { EvidenceFileStore } from "./recordFiles.js";
import { EmbeddedEvidenceStore } from "./evidenceStore.js";
import { InMemoryCounterStore } from "./counters.js";
import {
  EmbeddedAccessAuditLog,
  EmbeddedApiKeyStore,
  EmbeddedTenantStore,
} from "./identityStores.js";
import {
  EmbeddedAssuranceStore,
  EmbeddedEvidenceOpsStore,
  EmbeddedMandateStore,
  EmbeddedPolicyStore,
} from "./governanceStores.js";
import { EmbeddedEscalationStore, EmbeddedReviewNotifier } from "./reviewStores.js";

export interface EmbeddedStorageConfig {
  /**
   * Directory holding `pharos.db` (operational state + chain heads) and `evidence/`
   * (content-addressed record files). `":memory:"` keeps everything in process (tests).
   */
  dataDir: string;
}

export interface EmbeddedStorageDeps {
  signer: SigningProvider;
  resolveKeyName: (tenantId: string) => string;
  notifier?: ReviewNotifierOptions;
  now?: () => Date;
}

/**
 * The honest label. Every surface that prints what embedded mode guarantees reads it from
 * here; nothing may describe embedded evidence as WORM.
 */
export const EMBEDDED_EVIDENCE_POSTURE: EvidencePosture = {
  backend: "embedded",
  immutability: "tamper-evident-local-files",
  worm: false,
  rowLevelSecurity: false,
  multiInstanceRateLimits: false,
  description:
    "SQLite operational state and chain heads plus content-addressed record files on the local " +
    "filesystem, sealed and appended in one transaction. Tamper-evident and offline-verifiable; " +
    "NOT write-once storage — anyone with filesystem access can delete or replace files, and " +
    "the chain, seals and reconciler will show it. No database-level tenant isolation; rate " +
    "limits are per process. For retention guarantees use the Postgres + S3 Object Lock path.",
};

export interface EmbeddedStorageBackend extends StorageBackend {
  readonly db: EmbeddedDb;
  readonly files: EvidenceFileStore;
}

/**
 * Zero-infrastructure storage: one SQLite file and one directory of record files. The
 * verdict-and-seal invariant holds in a single SQLite transaction (see
 * `EmbeddedEvidenceStore.append`). Requires nothing but Node ≥ 22.13 (`node:sqlite`).
 */
export async function buildEmbeddedStorage(
  config: EmbeddedStorageConfig,
  deps: EmbeddedStorageDeps,
): Promise<EmbeddedStorageBackend> {
  const inMemory = config.dataDir === ":memory:";
  const db = new EmbeddedDb(inMemory ? ":memory:" : join(config.dataDir, "pharos.db"));
  await runEmbeddedMigrations(db);

  // An in-memory database still needs somewhere for record files; use a private temp dir.
  const files = new EvidenceFileStore(
    inMemory ? mkdtempSync(join(tmpdir(), "pharos-embedded-")) : join(config.dataDir, "evidence"),
  );
  files.ensureStore();

  const counters = new InMemoryCounterStore();
  const store = new EmbeddedEvidenceStore({
    db,
    files,
    signer: deps.signer,
    resolveKeyName: deps.resolveKeyName,
    ...(deps.now ? { now: deps.now } : {}),
  });

  return {
    posture: EMBEDDED_EVIDENCE_POSTURE,
    db,
    files,
    store,
    tenants: new EmbeddedTenantStore(db),
    apiKeys: new EmbeddedApiKeyStore(db),
    accessAudit: new EmbeddedAccessAuditLog(db, deps.now),
    mandates: new EmbeddedMandateStore(db),
    escalations: new EmbeddedEscalationStore(db),
    notifier: new EmbeddedReviewNotifier(db, deps.notifier ?? {}),
    evidenceOps: new EmbeddedEvidenceOpsStore(db),
    policyStore: new EmbeddedPolicyStore(db),
    assurance: new EmbeddedAssuranceStore(db),
    counters,
    close: async () => {
      await counters.close();
      await db.exclusive(() => db.close());
    },
  };
}
