import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { LocalKms } from "@pharos/core";
import { buildEmbeddedStorage } from "@pharos/storage";
import { MemoryKeystore } from "./support/memoryKeystore.js";
import { runStorageConformance } from "./storageConformance.js";

/**
 * The embedded backend needs no Docker and must therefore NEVER skip — the CI gate fails the
 * build on any skipped test, and an embedded suite that could skip would hide a broken
 * on-ramp behind a green summary.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

runStorageConformance({
  name: "embedded (SQLite + local record files)",
  requireAvailable: true,
  makeBackend: async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pharos-embedded-"));
    dirs.push(dataDir);
    const signer = new LocalKms(new MemoryKeystore());
    const backend = await buildEmbeddedStorage(
      { dataDir },
      { signer, resolveKeyName: (tenantId) => `tenant:${tenantId}` },
    );
    return { backend, signer };
  },
});
