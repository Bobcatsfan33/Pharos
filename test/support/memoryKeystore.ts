import type { KeystoreBackend, StoredKey } from "@pharos/core";

/** Shared hermetic keystore for signing-provider tests. */
export class MemoryKeystore implements KeystoreBackend {
  private readonly entries = new Map<string, StoredKey>();

  async get(keyId: string): Promise<StoredKey | null> {
    return this.entries.get(keyId) ?? null;
  }

  async put(key: StoredKey): Promise<void> {
    if (this.entries.has(key.keyId)) throw new Error(`duplicate key ${key.keyId}`);
    this.entries.set(key.keyId, key);
  }

  async list(): Promise<StoredKey[]> {
    return [...this.entries.values()];
  }
}
