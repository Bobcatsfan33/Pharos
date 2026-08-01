import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { WormStore, WormIntegrityError } from "@pharos/storage";
import { sha256Hex, ACTION_RECORD_SCHEMA_VERSION } from "@pharos/core";
import type { ActionRecord } from "@pharos/core";

/**
 * WORM tamper-evidence (threat-model issue #77).
 *
 * The WORM copy exists to be the backstop that does *not* depend on Pharos behaving
 * well. Three gaps undercut that:
 *
 *   (a) `getRecord` JSON-parsed and returned whatever the object store handed back,
 *       never re-deriving the hash. The one copy held specifically to detect tampering
 *       was the one copy read without checking.
 *   (b) `reconcile()` was cited in comments as the reason a post-PUT commit failure is
 *       harmless, but it did not exist — so nothing detected an orphan, and nothing
 *       detected the far more serious inverse: a committed record whose evidence
 *       object is *gone*.
 *   (c) `ensureBucket` returned as soon as HeadBucket succeeded, so a pre-existing
 *       bucket without Object Lock silently provided no immutability at all.
 */
const ENDPOINT = process.env.PHAROS_S3_ENDPOINT ?? "http://localhost:9010";
const ACCESS_KEY = process.env.PHAROS_S3_ACCESS_KEY ?? "pharos";
const SECRET_KEY = process.env.PHAROS_S3_SECRET_KEY ?? "pharos_local_dev";
const REGION = process.env.PHAROS_S3_REGION ?? "us-east-1";

let available = true;
let client: S3Client | null = null;
const createdBuckets: string[] = [];

function makeStore(bucket: string): WormStore {
  return new WormStore({
    endpoint: ENDPOINT,
    region: REGION,
    bucket,
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    forcePathStyle: true,
    retentionDays: 1,
  });
}

/** A structurally valid, self-consistent sealed record (signature not exercised here). */
function makeRecord(tenantId: string, sequence: number): ActionRecord {
  const content = {
    schemaVersion: ACTION_RECORD_SCHEMA_VERSION,
    id: randomUUID(),
    tenantId,
    sequence,
    action: {
      type: "email.send",
      agentId: "agent-1",
      payload: { to: "x@y.com" },
      emittedAt: new Date(0).toISOString(),
    },
    verdict: {
      decision: "allow" as const,
      tierReached: 1 as const,
      ruleCitations: [],
      riskScore: 0,
      failMode: null,
      judgeVersion: null,
      latency: { totalMs: 1, perTier: {}, deadlineMs: 800, deadlineBreached: false },
    },
    liability: {
      mandate: null,
      oversightMode: "autonomous" as const,
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" as const },
      modelMetadata: null,
    },
    sealedAt: new Date(0).toISOString(),
  };
  return {
    content,
    seal: {
      contentHash: sha256Hex(content),
      prevHash: "0".repeat(64),
      algorithm: "ed25519" as const,
      keyId: "test-key",
      signature: "not-verified-here",
      sigVersion: 2 as const,
    },
  } as unknown as ActionRecord;
}

/** Write raw bytes at an exact key, bypassing WormStore's own addressing. */
async function putRaw(bucket: string, key: string, body: string): Promise<void> {
  await client!.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }),
  );
}

async function makeBucket(withLock: boolean): Promise<string> {
  const bucket = `worm-test-${randomUUID().slice(0, 12)}`;
  await client!.send(
    new CreateBucketCommand({
      Bucket: bucket,
      ...(withLock ? { ObjectLockEnabledForBucket: true } : {}),
    }),
  );
  createdBuckets.push(bucket);
  return bucket;
}

beforeAll(async () => {
  try {
    client = new S3Client({
      endpoint: ENDPOINT,
      region: REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
    // Probe reachability before any test depends on it.
    await makeBucket(true);
  } catch (err) {
    console.warn("[worm] object store unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  // Only unlocked objects can be removed; locked test objects expire with retention.
  for (const bucket of createdBuckets) {
    try {
      const versions = await client!.send(new ListObjectVersionsCommand({ Bucket: bucket }));
      for (const v of versions.Versions ?? []) {
        await client!
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: v.Key!, VersionId: v.VersionId }))
          .catch(() => {});
      }
      await client!.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {});
    } catch {
      // Best-effort cleanup; a retained object legitimately refuses deletion.
    }
  }
});

describe("WORM verify-on-read", () => {
  it("returns a record whose body still hashes to its sealed content hash", async (ctx) => {
    if (!available) return ctx.skip();
    const bucket = createdBuckets[0]!;
    const store = makeStore(bucket);
    const record = makeRecord("t-ok", 0);
    const { key } = await store.putRecord(record, store.retainUntil(new Date()));

    const read = await store.getRecord(key);
    expect(read?.content.id).toBe(record.content.id);
    expect(read?.seal.contentHash).toBe(record.seal.contentHash);
  });

  it("REFUSES a record whose body was altered after sealing", async (ctx) => {
    if (!available) return ctx.skip();
    const bucket = await makeBucket(true);
    const store = makeStore(bucket);
    const record = makeRecord("t-tamper", 0);
    const key = store.keyFor("t-tamper", 0, record.seal.contentHash);

    // The payload is rewritten while the seal is left intact — the exact shape of a
    // tamper that a plain JSON.parse would hand back as if it were evidence.
    const tampered = {
      ...record,
      content: {
        ...record.content,
        action: { ...record.content.action, payload: { to: "attacker@evil.test" } },
      },
    };
    await putRaw(bucket, key, JSON.stringify(tampered));

    // Refused, not returned-with-a-warning: handing back evidence known to be
    // inconsistent is worse than failing the read.
    await expect(store.getRecord(key)).rejects.toThrow(WormIntegrityError);
    await expect(store.getRecord(key)).rejects.toThrow(/content hash/i);
  });

  it("REFUSES a record served under a key that does not address it", async (ctx) => {
    if (!available) return ctx.skip();
    const bucket = await makeBucket(true);
    const store = makeStore(bucket);
    const record = makeRecord("t-swap", 7);

    // Internally consistent record, but parked at another record's address. Without a
    // key binding this would let one sealed record be substituted for another.
    const wrongKey = store.keyFor("t-swap", 9, record.seal.contentHash);
    await putRaw(bucket, wrongKey, JSON.stringify(record));

    await expect(store.getRecord(wrongKey)).rejects.toThrow(WormIntegrityError);
  });

  it("REFUSES an object that is not a well-formed record at all", async (ctx) => {
    if (!available) return ctx.skip();
    const bucket = await makeBucket(true);
    const store = makeStore(bucket);
    await putRaw(bucket, "t-junk/000000000000-deadbeef.json", JSON.stringify({ hello: "world" }));

    await expect(store.getRecord("t-junk/000000000000-deadbeef.json")).rejects.toThrow(
      WormIntegrityError,
    );
  });

  it("still reports a genuinely absent object as null, not as tampering", async (ctx) => {
    if (!available) return ctx.skip();
    const store = makeStore(createdBuckets[0]!);
    expect(await store.getRecord("t-missing/000000000000-abc.json")).toBeNull();
  });
});

describe("WORM bucket posture", () => {
  it("accepts a pre-existing bucket that has Object Lock enabled", async (ctx) => {
    if (!available) return ctx.skip();
    const bucket = await makeBucket(true);
    await expect(makeStore(bucket).ensureBucket()).resolves.toBeUndefined();
  });

  it("REFUSES a pre-existing bucket without Object Lock", async (ctx) => {
    if (!available) return ctx.skip();
    // The gap in #77(c): HeadBucket succeeds, so the old code returned and the platform
    // ran with no immutability whatsoever while believing it had WORM.
    const bucket = await makeBucket(false);
    await expect(makeStore(bucket).ensureBucket()).rejects.toThrow(WormIntegrityError);
    await expect(makeStore(bucket).ensureBucket()).rejects.toThrow(/object lock/i);
  });
});

describe("WORM reconcile", () => {
  it("reports a clean prefix as reconciled", async (ctx) => {
    if (!available) return ctx.skip();
    const bucket = await makeBucket(true);
    const store = makeStore(bucket);
    const tenant = "t-clean";
    const record = makeRecord(tenant, 0);
    const { key } = await store.putRecord(record, store.retainUntil(new Date()));

    const report = await store.reconcile(tenant, [{ sequence: 0, wormKey: key }]);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(report.orphans).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it("detects an orphan: a WORM object with no committed record", async (ctx) => {
    if (!available) return ctx.skip();
    const bucket = await makeBucket(true);
    const store = makeStore(bucket);
    const tenant = "t-orphan";
    // The post-PUT-commit-failure case the evidenceStore comment calls harmless. It IS
    // harmless — but only because it is detectable, which is what this proves.
    const orphan = makeRecord(tenant, 0);
    const { key } = await store.putRecord(orphan, store.retainUntil(new Date()));

    const report = await store.reconcile(tenant, []);
    expect(report.orphans).toEqual([key]);
    expect(report.missing).toEqual([]);
    // Orphans alone do not fail reconciliation: no evidence is lost.
    expect(report.ok).toBe(true);
  });

  it("FAILS reconciliation when a committed record has no WORM object", async (ctx) => {
    if (!available) return ctx.skip();
    const bucket = await makeBucket(true);
    const store = makeStore(bucket);
    const tenant = "t-missing";
    // The serious direction: Postgres claims a sealed record whose tamper-proof copy
    // is absent. This must never be reported as ok.
    const report = await store.reconcile(tenant, [
      { sequence: 4, wormKey: `${tenant}/000000000004-${"a".repeat(64)}.json` },
    ]);

    expect(report.ok).toBe(false);
    expect(report.missing).toHaveLength(1);
    expect(report.missing[0]?.sequence).toBe(4);
  });
});
