import { buildEmbeddedStorage } from "./embedded/backend.js";
import { buildPostgresStorage } from "./postgresBackend.js";
import { registerStorageBackend } from "./registry.js";

/**
 * The storage backends that ship with Pharos, registered under the names the configuration
 * selects them by. `packages/config` validates the name as kebab-case; this registry is what
 * decides whether it actually exists.
 */

/** Postgres + S3 Object Lock + Redis. The production path and the default. */
registerStorageBackend("postgres", async ({ settings, signer, resolveKeyName, notifier }) => {
  const { pgUrl, redisUrl, s3 } = settings;
  if (!pgUrl || !redisUrl || !s3) {
    throw new Error(
      "the postgres storage backend requires PHAROS_PG_URL, PHAROS_REDIS_URL and the PHAROS_S3_* settings",
    );
  }
  return buildPostgresStorage({ pgUrl, redisUrl, s3 }, { signer, resolveKeyName, notifier });
});

/**
 * SQLite + local record files, no infrastructure. The on-ramp: tamper-evident and
 * offline-verifiable, NOT WORM — see docs/LIMITATIONS.md. Production refuses it.
 */
registerStorageBackend("embedded", async ({ settings, signer, resolveKeyName, notifier }) => {
  if (!settings.dataDir) {
    throw new Error("the embedded storage backend requires a data directory (PHAROS_DATA_DIR)");
  }
  return buildEmbeddedStorage({ dataDir: settings.dataDir }, { signer, resolveKeyName, notifier });
});
