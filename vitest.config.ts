import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@pharos/core": r("./packages/core/src/index.ts"),
      "@pharos/config": r("./packages/config/src/index.ts"),
      "@pharos/identity": r("./packages/identity/src/index.ts"),
      "@pharos/judge": r("./packages/judge/src/index.ts"),
      "@pharos/cascade": r("./packages/cascade/src/index.ts"),
      "@pharos/sdk": r("./packages/sdk-ts/src/index.ts"),
      "@pharos/middleware": r("./packages/middleware/src/index.ts"),
      "@pharos/gateway": r("./services/gateway/src/index.ts"),
      "@pharos/review": r("./packages/review/src/index.ts"),
      "@pharos/storage": r("./packages/storage/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    // Integration suites share one Postgres/WORM instance and run migrations on boot;
    // run files serially to avoid migration races and cross-suite interference.
    fileParallelism: false,
  },
});
