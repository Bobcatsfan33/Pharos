import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  GetObjectLockConfigurationCommand,
} from "@aws-sdk/client-s3";
import { ActionRecordSchema, sha256Hex, type ActionRecord } from "@pharos/core";

/**
 * The WORM copy failed an integrity check.
 *
 * Always thrown, never returned as a flag: a caller that receives a record has a
 * record whose body still hashes to its seal, and one that does not receives nothing.
 * Handing back evidence known to be inconsistent — even annotated — invites a caller
 * to use it anyway.
 */
export class WormIntegrityError extends Error {
  constructor(
    readonly reason: string,
    readonly key?: string,
  ) {
    super(
      key ? `WORM integrity failure for ${key}: ${reason}` : `WORM integrity failure: ${reason}`,
    );
    this.name = "WormIntegrityError";
  }
}

/** A record Postgres claims to have committed, and the WORM object it should have. */
export interface CommittedRecordRef {
  sequence: number;
  wormKey: string;
}

export interface WormReconciliation {
  tenantId: string;
  /** Committed records checked against the object store. */
  checked: number;
  /** WORM objects with no committed record — benign by construction, but surfaced. */
  orphans: string[];
  /** Committed records whose WORM object is absent. Evidence loss; never ok. */
  missing: CommittedRecordRef[];
  /** True when no committed record is missing its object. */
  ok: boolean;
}

export interface WormStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  /** Omit both to use the AWS SDK default chain (IRSA/workload identity/instance role). */
  accessKey?: string;
  secretKey?: string;
  forcePathStyle: boolean;
  retentionDays: number;
}

export interface WormPutResult {
  key: string;
  versionId: string | undefined;
}

/**
 * S3-compatible WORM evidence store.
 *
 * Sealed records are written with Object Lock (COMPLIANCE mode) so they cannot be
 * overwritten or deleted before the retention period elapses — tamper-evidence that
 * does not rely on Pharos behaving well. Objects are content-addressed by the record
 * sequence and content hash, which makes writes idempotent and lets a reconciler
 * detect orphaned objects (written to WORM but never committed to Postgres).
 */
export class WormStore {
  private readonly client: S3Client;
  constructor(private readonly cfg: WormStoreConfig) {
    const credentials =
      cfg.accessKey && cfg.secretKey
        ? { credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey } }
        : {};
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      ...credentials,
    });
  }

  keyFor(tenantId: string, sequence: number, contentHash: string): string {
    const seq = String(sequence).padStart(12, "0");
    return `${tenantId}/${seq}-${contentHash}.json`;
  }

  /**
   * Create the evidence bucket with Object Lock enabled, or assert that a pre-existing
   * one has it.
   *
   * The assertion is the point. HeadBucket succeeding only proves a bucket exists; it
   * says nothing about immutability. Without this check the platform would run against
   * an ordinary bucket, believing every sealed record was protected by COMPLIANCE-mode
   * retention while in fact any of them could be overwritten or deleted. That is a
   * silent, total loss of the tamper-evidence property, so it fails closed at startup
   * rather than at the first attempted audit.
   */
  async ensureBucket(): Promise<void> {
    let exists = true;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
    } catch {
      exists = false;
    }

    if (!exists) {
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.cfg.bucket, ObjectLockEnabledForBucket: true }),
      );
    }

    await this.assertObjectLockEnabled();
  }

  /** Fail closed unless the bucket reports Object Lock enabled. */
  private async assertObjectLockEnabled(): Promise<void> {
    let enabled: string | undefined;
    try {
      const res = await this.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.cfg.bucket }),
      );
      enabled = res.ObjectLockConfiguration?.ObjectLockEnabled;
    } catch (err) {
      // ObjectLockConfigurationNotFoundError is the ordinary "not enabled" answer;
      // anything else is an unknown posture. Neither is proof of immutability, so
      // both refuse.
      throw new WormIntegrityError(
        `object lock configuration could not be confirmed on bucket ${this.cfg.bucket}: ` +
          `${(err as Error).name}. Evidence immutability is unproven; refusing to use it.`,
      );
    }
    if (enabled !== "Enabled") {
      throw new WormIntegrityError(
        `bucket ${this.cfg.bucket} does not have object lock enabled (got ${enabled ?? "none"}). ` +
          `Sealed records would be overwritable; refusing to use it as a WORM store.`,
      );
    }
  }

  async putRecord(record: ActionRecord, retainUntil: Date): Promise<WormPutResult> {
    const key = this.keyFor(
      record.content.tenantId,
      record.content.sequence,
      record.seal.contentHash,
    );
    const body = JSON.stringify(record);
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );
    return { key, versionId: res.VersionId };
  }

  retainUntil(from: Date): Date {
    return new Date(from.getTime() + this.cfg.retentionDays * 24 * 60 * 60 * 1000);
  }

  /**
   * Read a sealed record and prove it is the one that was written (verify-on-read).
   *
   * This is the copy kept specifically to detect tampering, so reading it without
   * checking defeated its only purpose. Three properties are established before the
   * record is handed back:
   *
   *   1. it parses as a well-formed ActionRecord;
   *   2. its body still hashes to its own `seal.contentHash` — catching any edit to
   *      the content that left the seal in place;
   *   3. the key it was served under addresses exactly this record — catching a valid
   *      record substituted at another record's address.
   *
   * Note the limit, deliberately: this verifies self-consistency and addressing, not
   * the signature, because the WORM store holds no keyset. Signature and chain-link
   * verification belong to `verifyRecord`/`verifyChain` against the published keyset.
   * A missing object is `null`; a *corrupt* object throws.
   */
  async getRecord(key: string): Promise<ActionRecord | null> {
    let text: string | undefined;
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      text = await res.Body?.transformToString();
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
    if (!text) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WormIntegrityError("object is not valid JSON", key);
    }

    const record = ActionRecordSchema.safeParse(parsed);
    if (!record.success) {
      throw new WormIntegrityError(
        `object is not a well-formed action record: ${record.error.issues
          .map((i) => i.message)
          .join("; ")}`,
        key,
      );
    }

    const recomputed = sha256Hex(record.data.content);
    if (recomputed !== record.data.seal.contentHash) {
      throw new WormIntegrityError(
        `content hash mismatch: recomputed ${recomputed} != sealed ${record.data.seal.contentHash}`,
        key,
      );
    }

    const expectedKey = this.keyFor(
      record.data.content.tenantId,
      record.data.content.sequence,
      record.data.seal.contentHash,
    );
    if (expectedKey !== key) {
      throw new WormIntegrityError(`object is stored at ${key} but addresses ${expectedKey}`, key);
    }

    return record.data;
  }

  /**
   * Reconcile committed records against the objects actually present in WORM.
   *
   * Two asymmetric findings:
   *
   *   - **orphans** — objects with no committed record. Expected: a transaction that
   *     rolled back after its PUT leaves one behind. They are harmless *because* they
   *     are content-addressed and detectable, which is precisely the claim this method
   *     makes good on; they do not fail reconciliation.
   *   - **missing** — a committed record whose evidence object is absent. This is
   *     evidence loss and always fails reconciliation, regardless of cause.
   *
   * `committed` is supplied by the caller (the authoritative Postgres side) so this
   * stays a pure object-store operation with no database coupling.
   */
  async reconcile(tenantId: string, committed: CommittedRecordRef[]): Promise<WormReconciliation> {
    const present = new Set(await this.listKeys(`${tenantId}/`));
    const expected = new Set(committed.map((c) => c.wormKey));

    const missing = committed.filter((c) => !present.has(c.wormKey));
    const orphans = [...present].filter((k) => !expected.has(k)).sort();

    return {
      tenantId,
      checked: committed.length,
      orphans,
      missing,
      ok: missing.length === 0,
    };
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}
