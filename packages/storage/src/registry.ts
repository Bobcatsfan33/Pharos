import type { SigningProvider } from "@pharos/core";
import type { ReviewNotifierOptions } from "./notifier.js";
import type { StorageBackend } from "./ports.js";
import type { WormStoreConfig } from "./wormStore.js";

/**
 * Storage-backend registry.
 *
 * The composition root selects a backend by name (`PHAROS_STORAGE_BACKEND`) and asks this
 * registry to build it. Adding a backend is one file that returns a `StorageBackend` plus one
 * `registerStorageBackend` call; nothing central is edited. Same shape as the signing, TSA and
 * judge registries — see CONTRIBUTING.md "Where a change goes".
 *
 * A backend must declare an honest `EvidencePosture`. Nothing may claim WORM retention unless
 * the evidence tier enforces write-once independently of Pharos.
 */
export interface StorageBackendSettings {
  /** Postgres connection string. Required by the `postgres` backend. */
  pgUrl?: string | undefined;
  /** Redis connection string for shared rate-limit counters. Required by `postgres`. */
  redisUrl?: string | undefined;
  /** S3 / object-store settings for the WORM evidence tier. Required by `postgres`. */
  s3?: WormStoreConfig | undefined;
  /** Single directory holding the database, record files and keystore. Used by `embedded`. */
  dataDir?: string | undefined;
}

export interface StorageBackendContext {
  settings: StorageBackendSettings;
  /** Signs every sealed record; built from the signing-provider registry, never directly. */
  signer: SigningProvider;
  /** Per-tenant signing key name (matches the tenant store's `kmsKeyName`). */
  resolveKeyName: (tenantId: string) => string;
  notifier: ReviewNotifierOptions;
}

export type StorageBackendFactory = (ctx: StorageBackendContext) => Promise<StorageBackend>;

const factories = new Map<string, StorageBackendFactory>();

/** Register a storage backend under the name `PHAROS_STORAGE_BACKEND` selects it by. */
export function registerStorageBackend(name: string, factory: StorageBackendFactory): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`storage backend name must be lower-case kebab-case, got "${name}"`);
  }
  factories.set(name, factory);
}

/** Build the named storage backend, or throw naming the backends that are registered. */
export async function createStorageBackend(
  name: string,
  ctx: StorageBackendContext,
): Promise<StorageBackend> {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(
      `unknown storage backend "${name}"; registered: ${listStorageBackends().join(", ")}`,
    );
  }
  return factory(ctx);
}

export function hasStorageBackend(name: string): boolean {
  return factories.has(name);
}

export function listStorageBackends(): string[] {
  return [...factories.keys()].sort();
}
