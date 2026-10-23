import { LocalKms } from "@pharos/core";
import { buildPostgresStorage } from "@pharos/storage";
import { MemoryKeystore } from "./support/memoryKeystore.js";
import { runStorageConformance } from "./storageConformance.js";

// Same defaults as every other integration suite; CI provisions these and never skips.
process.env.PHAROS_PG_URL ??= "postgres://pharos:pharos_local_dev@localhost:5433/pharos";
process.env.PHAROS_REDIS_URL ??= "redis://localhost:6380";
process.env.PHAROS_S3_ENDPOINT ??= "http://localhost:9010";
process.env.PHAROS_S3_REGION ??= "us-east-1";
process.env.PHAROS_S3_BUCKET ??= "pharos-evidence";
process.env.PHAROS_S3_ACCESS_KEY ??= "pharos";
process.env.PHAROS_S3_SECRET_KEY ??= "pharos_local_dev";

/**
 * The production backend runs the SAME conformance cases as the embedded one. Anything the
 * embedded backend can do, Postgres + S3 WORM + Redis must do identically; backend-specific
 * guarantees (Object Lock, RLS) are asserted in their own suites, not here.
 */
runStorageConformance({
  name: "postgres + s3 worm + redis",
  makeBackend: async () => {
    const signer = new LocalKms(new MemoryKeystore());
    const backend = await buildPostgresStorage(
      {
        pgUrl: process.env.PHAROS_PG_URL!,
        redisUrl: process.env.PHAROS_REDIS_URL!,
        s3: {
          endpoint: process.env.PHAROS_S3_ENDPOINT!,
          region: process.env.PHAROS_S3_REGION!,
          bucket: process.env.PHAROS_S3_BUCKET!,
          accessKey: process.env.PHAROS_S3_ACCESS_KEY,
          secretKey: process.env.PHAROS_S3_SECRET_KEY,
          forcePathStyle: true,
          retentionDays: 1,
        },
      },
      {
        signer,
        resolveKeyName: (tenantId) => `tenant:${tenantId}`,
        notifier: {
          queuePolicy: { "treasury-control": ["email", "slack"] },
          defaultChannels: ["email"],
        },
      },
    );
    await backend.counters.connect();
    return { backend, signer };
  },
});
