import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { ActionRecord } from "@pharos/core";

export interface WormStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
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
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  }

  keyFor(tenantId: string, sequence: number, contentHash: string): string {
    const seq = String(sequence).padStart(12, "0");
    return `${tenantId}/${seq}-${contentHash}.json`;
  }

  /** Create the evidence bucket with Object Lock enabled if it does not exist. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
      return;
    } catch {
      // fall through to create
    }
    await this.client.send(
      new CreateBucketCommand({ Bucket: this.cfg.bucket, ObjectLockEnabledForBucket: true }),
    );
  }

  async putRecord(record: ActionRecord, retainUntil: Date): Promise<WormPutResult> {
    const key = this.keyFor(record.content.tenantId, record.content.sequence, record.seal.contentHash);
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

  async getRecord(key: string): Promise<ActionRecord | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      const text = await res.Body?.transformToString();
      if (!text) return null;
      return JSON.parse(text) as ActionRecord;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}
