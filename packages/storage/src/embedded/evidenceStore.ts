import { randomUUID } from "node:crypto";
import {
  type ActionRecord,
  type SigningProvider,
  ACTION_RECORD_SCHEMA_VERSION,
  GENESIS_HASH,
  sealRecord,
  computeDisclosures,
  disclosureBindingMessage,
} from "@pharos/core";
import {
  IdempotencyConflictError,
  IdempotencyReplayError,
  type AppendInput,
  type RecordDisclosure,
} from "../evidenceStore.js";
import type { EvidenceReconciliation, EvidenceStorePort } from "../ports.js";
import { EvidenceFileStore } from "./recordFiles.js";
import { EmbeddedDb, isUniqueViolation, nowIso, parseJson } from "./sqlite.js";

export interface EmbeddedEvidenceStoreDeps {
  db: EmbeddedDb;
  files: EvidenceFileStore;
  signer: SigningProvider;
  resolveKeyName: (tenantId: string) => string;
  now?: () => Date;
}

interface RecordRow {
  tenant_id: string;
  sequence: number;
  id: string;
  content_hash: string;
  prev_hash: string;
  algorithm: string;
  key_id: string;
  signature: string;
  content: string;
  worm_key: string | null;
  disclosure_root: string | null;
  disclosure_sig: string | null;
  salts: string | null;
  commitments: string | null;
  sig_version: number | null;
}

const SELECT_RECORD = `SELECT * FROM action_records`;

/**
 * The embedded transactional write path.
 *
 * `append()` holds the single write lock, opens `BEGIN IMMEDIATE`, allocates the next
 * per-tenant sequence from `tenant_chain_head`, seals the record (hash + signature linking it
 * to the prior head), writes the record file with fsync, inserts the operational row, advances
 * the head, claims the idempotency key, and commits — one SQLite transaction. If the file
 * write fails the transaction rolls back and no verdict is recorded. A file orphaned by a
 * post-write commit failure is content-addressed and detected by `reconcileEvidence()`,
 * exactly as with the WORM store.
 *
 * The verdict-and-seal invariant therefore holds here as it does on Postgres: a verdict is
 * never returned before its record is durably sealed in the same transaction.
 */
export class EmbeddedEvidenceStore implements EvidenceStorePort {
  constructor(private readonly deps: EmbeddedEvidenceStoreDeps) {}

  private get db(): EmbeddedDb {
    return this.deps.db;
  }

  async append(input: AppendInput): Promise<ActionRecord> {
    const { db, files, signer } = this.deps;
    return db.transaction(async () => {
      db.run(
        `INSERT OR IGNORE INTO tenant_chain_head (tenant_id, last_sequence, last_hash, updated_at)
         VALUES (?, -1, ?, ?)`,
        input.tenantId,
        GENESIS_HASH,
        nowIso(this.deps.now),
      );
      const head = db.get<{ last_sequence: number; last_hash: string }>(
        `SELECT last_sequence, last_hash FROM tenant_chain_head WHERE tenant_id = ?`,
        input.tenantId,
      )!;
      const sequence = Number(head.last_sequence) + 1;
      const prevHash = head.last_hash;

      const sealedAt = nowIso(this.deps.now);
      const keyName = this.deps.resolveKeyName(input.tenantId);
      const keyId = await signer.ensureKey(keyName);
      const record = await sealRecord({
        content: {
          schemaVersion: ACTION_RECORD_SCHEMA_VERSION,
          id: randomUUID(),
          tenantId: input.tenantId,
          sequence,
          action: input.action,
          verdict: input.verdict,
          liability: input.liability,
          sealedAt,
        },
        prevHash,
        signer,
        keyId,
      });

      const disclosures = computeDisclosures(record.content.action.payload);
      const disclosureSig = await signer.sign(
        keyId,
        disclosureBindingMessage(disclosures.disclosureRoot, record.seal.contentHash),
      );

      // Record file first (fsynced); a failure here aborts the whole append.
      const { key: wormKey } = files.putRecord(record);

      db.run(
        `INSERT INTO action_records
           (tenant_id, sequence, id, content_hash, prev_hash, algorithm, key_id, signature,
            content, worm_key, worm_version_id, decision, sealed_at, created_at,
            disclosure_root, disclosure_sig, salts, commitments, sig_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.tenantId,
        sequence,
        record.content.id,
        record.seal.contentHash,
        record.seal.prevHash,
        record.seal.algorithm,
        record.seal.keyId,
        record.seal.signature,
        JSON.stringify(record.content),
        wormKey,
        null,
        record.content.verdict.decision,
        sealedAt,
        sealedAt,
        disclosures.disclosureRoot,
        disclosureSig,
        JSON.stringify(disclosures.salts),
        JSON.stringify(disclosures.commitments),
        record.seal.sigVersion ?? null,
      );
      db.run(
        `UPDATE tenant_chain_head SET last_sequence = ?, last_hash = ?, updated_at = ? WHERE tenant_id = ?`,
        sequence,
        record.seal.contentHash,
        sealedAt,
        input.tenantId,
      );

      if (input.idempotency) {
        try {
          db.run(
            `INSERT INTO ingest_idempotency (tenant_id, idempotency_key, request_fingerprint, sequence, created_at)
             VALUES (?,?,?,?,?)`,
            input.tenantId,
            input.idempotency.key,
            input.idempotency.requestFingerprint,
            sequence,
            sealedAt,
          );
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          throw new IdempotencyReplayError(input.idempotency.key);
        }
      }
      return record;
    });
  }

  private rowToRecord(row: RecordRow): ActionRecord {
    return {
      content: parseJson(row.content) as ActionRecord["content"],
      seal: {
        contentHash: row.content_hash,
        prevHash: row.prev_hash,
        algorithm: row.algorithm as "ed25519",
        keyId: row.key_id,
        signature: row.signature,
        ...(row.sig_version != null ? { sigVersion: row.sig_version as 1 | 2 } : {}),
      },
    };
  }

  getRecord(tenantId: string, sequence: number): Promise<ActionRecord | null> {
    return this.db.exclusive(() => {
      const row = this.db.get<RecordRow>(
        `${SELECT_RECORD} WHERE tenant_id = ? AND sequence = ?`,
        tenantId,
        sequence,
      );
      return row ? this.rowToRecord(row) : null;
    });
  }

  getRecordById(tenantId: string, id: string): Promise<ActionRecord | null> {
    return this.db.exclusive(() => {
      const row = this.db.get<RecordRow>(
        `${SELECT_RECORD} WHERE id = ? AND tenant_id = ?`,
        id,
        tenantId,
      );
      return row ? this.rowToRecord(row) : null;
    });
  }

  async findByIdempotencyKey(
    tenantId: string,
    key: string,
    requestFingerprint: string,
  ): Promise<ActionRecord | null> {
    const claim = await this.db.exclusive(() =>
      this.db.get<{ sequence: number; request_fingerprint: string }>(
        `SELECT sequence, request_fingerprint FROM ingest_idempotency
         WHERE tenant_id = ? AND idempotency_key = ?`,
        tenantId,
        key,
      ),
    );
    if (!claim) return null;
    if (claim.request_fingerprint !== requestFingerprint) throw new IdempotencyConflictError(key);
    const record = await this.getRecord(tenantId, Number(claim.sequence));
    if (!record) {
      throw new Error(`idempotency claim ${key} references missing record ${claim.sequence}`);
    }
    return record;
  }

  getChain(tenantId: string): Promise<ActionRecord[]> {
    return this.db.exclusive(() =>
      this.db
        .all<RecordRow>(`${SELECT_RECORD} WHERE tenant_id = ? ORDER BY sequence ASC`, tenantId)
        .map((r) => this.rowToRecord(r)),
    );
  }

  getRange(
    tenantId: string,
    fromSequence: number,
    toSequence: number,
  ): Promise<RecordDisclosure[]> {
    return this.db.exclusive(() =>
      this.db
        .all<RecordRow>(
          `${SELECT_RECORD} WHERE tenant_id = ? AND sequence >= ? AND sequence <= ? ORDER BY sequence ASC`,
          tenantId,
          fromSequence,
          toSequence,
        )
        .map((r) => ({
          record: this.rowToRecord(r),
          disclosureRoot: r.disclosure_root ?? "",
          disclosureSignature: r.disclosure_sig ?? "",
          salts: (parseJson(r.salts) ?? {}) as Record<string, string>,
          commitments: (parseJson(r.commitments) ?? {}) as Record<string, string>,
          keyId: r.key_id,
        })),
    );
  }

  getHead(tenantId: string): Promise<{ sequence: number; hash: string } | null> {
    return this.db.exclusive(() => {
      const row = this.db.get<{ last_sequence: number; last_hash: string }>(
        `SELECT last_sequence, last_hash FROM tenant_chain_head WHERE tenant_id = ?`,
        tenantId,
      );
      if (!row || Number(row.last_sequence) < 0) return null;
      return { sequence: Number(row.last_sequence), hash: row.last_hash };
    });
  }

  listTenants(): Promise<string[]> {
    return this.db.exclusive(() =>
      this.db
        .all<{ tenant_id: string }>(`SELECT tenant_id FROM tenant_chain_head ORDER BY tenant_id`)
        .map((r) => r.tenant_id),
    );
  }

  countInPeriod(tenantId: string, fromIso?: string, toIso?: string): Promise<number> {
    return this.db.exclusive(() => {
      const conds = ["tenant_id = ?"];
      const params: (string | number)[] = [tenantId];
      if (fromIso) {
        conds.push("created_at >= ?");
        params.push(new Date(fromIso).toISOString());
      }
      if (toIso) {
        conds.push("created_at < ?");
        params.push(new Date(toIso).toISOString());
      }
      const row = this.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM action_records WHERE ${conds.join(" AND ")}`,
        ...params,
      );
      return Number(row?.n ?? 0);
    });
  }

  count(tenantId: string): Promise<number> {
    return this.db.exclusive(() => {
      const row = this.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM action_records WHERE tenant_id = ?`,
        tenantId,
      );
      return Number(row?.n ?? 0);
    });
  }

  async reconcileEvidence(tenantId: string): Promise<EvidenceReconciliation> {
    const committed = await this.db.exclusive(() =>
      this.db
        .all<{ sequence: number; worm_key: string }>(
          `SELECT sequence, worm_key FROM action_records WHERE tenant_id = ? ORDER BY sequence ASC`,
          tenantId,
        )
        .map((r) => ({ sequence: Number(r.sequence), wormKey: r.worm_key })),
    );
    return this.deps.files.reconcile(tenantId, committed);
  }
}
