import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ActionRecordSchema, sha256Hex, type ActionRecord } from "@pharos/core";
import {
  WormIntegrityError,
  type CommittedRecordRef,
  type WormReconciliation,
} from "../wormStore.js";

/**
 * Content-addressed record files on the local filesystem — the embedded stand-in for the
 * S3 Object Lock evidence tier.
 *
 * What it does: every sealed record is written to its own file, named by tenant, sequence
 * and content hash (the same key scheme as the WORM store), with `fsync` on the file and its
 * directory before the append transaction commits, read-only mode bits, and a never-overwrite
 * write (a hard link into place fails if the path already exists). Reads verify the file
 * still hashes to its seal and sits at the address it claims, exactly as the WORM store does.
 *
 * What it does NOT do, and must never be described as doing: enforce immutability against a
 * process with filesystem access. Anyone who can write to the data directory can delete or
 * replace a file. That makes this tier **tamper-evident** (the hash chain, the seal, and the
 * reconciler will show the damage) and **offline-verifiable**, but not **WORM**. Retention
 * guarantees require the Postgres + S3 Object Lock path.
 */
export class EvidenceFileStore {
  constructor(readonly rootDir: string) {}

  keyFor(tenantId: string, sequence: number, contentHash: string): string {
    const seq = String(sequence).padStart(12, "0");
    return `${tenantId}/${seq}-${contentHash}.json`;
  }

  /** Map a key to a path; the tenant segment is percent-encoded so it is always one directory. */
  pathFor(key: string): string {
    const slash = key.indexOf("/");
    const tenant = encodeURIComponent(key.slice(0, slash));
    return join(this.rootDir, tenant, key.slice(slash + 1));
  }

  /** Create the root directory (0700). Nothing to assert about immutability — see the class doc. */
  ensureStore(): void {
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Write a record file durably and without ever overwriting. Idempotent for an identical
   * body at the same address (content-addressed), an integrity error for a different one.
   */
  putRecord(record: ActionRecord): { key: string } {
    const key = this.keyFor(
      record.content.tenantId,
      record.content.sequence,
      record.seal.contentHash,
    );
    const final = this.pathFor(key);
    const dir = dirname(final);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify(record);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tmp, "wx", 0o444);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, final);
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") {
        unlinkSync(tmp);
        throw err;
      }
      const existing = readFileSync(final, "utf8");
      unlinkSync(tmp);
      if (existing !== body) {
        throw new WormIntegrityError("a different record already exists at this address", key);
      }
      return { key };
    }
    unlinkSync(tmp);
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
    return { key };
  }

  /** Verify-on-read, identical in contract to `WormStore.getRecord`. Missing = null; corrupt = throw. */
  getRecord(key: string): ActionRecord | null {
    let text: string;
    try {
      text = readFileSync(this.pathFor(key), "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WormIntegrityError("file is not valid JSON", key);
    }
    const record = ActionRecordSchema.safeParse(parsed);
    if (!record.success) {
      throw new WormIntegrityError(
        `file is not a well-formed action record: ${record.error.issues
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
      throw new WormIntegrityError(`file is stored at ${key} but addresses ${expectedKey}`, key);
    }
    return record.data;
  }

  listKeys(tenantId: string): string[] {
    const dir = join(this.rootDir, encodeURIComponent(tenantId));
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith(".json") && statSync(join(dir, n)).isFile())
      .map((n) => `${tenantId}/${n}`)
      .sort();
  }

  /** Same asymmetric semantics as `WormStore.reconcile`: orphans are benign, missing is never ok. */
  reconcile(tenantId: string, committed: CommittedRecordRef[]): WormReconciliation {
    const present = new Set(this.listKeys(tenantId));
    const expected = new Set(committed.map((c) => c.wormKey));
    const missing = committed.filter((c) => !present.has(c.wormKey));
    const orphans = [...present].filter((k) => !expected.has(k)).sort();
    return { tenantId, checked: committed.length, orphans, missing, ok: missing.length === 0 };
  }
}
