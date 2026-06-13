import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Keystore backend for the simulated local KMS.
 *
 * This represents the HSM boundary, not platform/evidence state: it stores key
 * material for the local-kms provider only. In production this is replaced by a
 * real KMS (AWS KMS / CloudHSM) and no key material is persisted by Pharos at all.
 */
export interface StoredKey {
  keyId: string;
  privateKeyDer: string; // base64 PKCS8
  publicKeyDer: string; // base64 SPKI
}

export interface KeystoreBackend {
  put(key: StoredKey): Promise<void>;
  get(keyId: string): Promise<StoredKey | null>;
  list(): Promise<StoredKey[]>;
}

/** Filesystem-backed keystore (one JSON file per key). Persists across restarts. */
export class FileKeystore implements KeystoreBackend {
  constructor(private readonly dir: string) {}

  private fileFor(keyId: string): string {
    // keyId may contain '#'; encode to a filesystem-safe name.
    return join(this.dir, `${encodeURIComponent(keyId)}.key.json`);
  }

  async put(key: StoredKey): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileFor(key.keyId), JSON.stringify(key), { mode: 0o600 });
  }

  async get(keyId: string): Promise<StoredKey | null> {
    try {
      const raw = await readFile(this.fileFor(keyId), "utf8");
      return JSON.parse(raw) as StoredKey;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(): Promise<StoredKey[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: StoredKey[] = [];
    for (const f of files) {
      if (!f.endsWith(".key.json")) continue;
      const raw = await readFile(join(this.dir, f), "utf8");
      out.push(JSON.parse(raw) as StoredKey);
    }
    return out;
  }
}
