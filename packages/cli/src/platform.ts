import { loadConfig } from "@pharos/config";
import { buildPlatform, type Platform } from "@pharos/api";
import { projectPolicies, type Project } from "./project.js";

/**
 * Open the project's embedded platform: the same `buildPlatform` the API server uses, over
 * the SQLite + record-file backend, with no environment required. Anything the environment
 * does set (PHAROS_*) still applies, so a developer can point the CLI at an ONNX judge cache
 * or a real TSA exactly as they would the server.
 */
export async function openPlatform(
  project: Project,
  extra: NodeJS.ProcessEnv = {},
): Promise<Platform> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PHAROS_STORAGE_BACKEND: "embedded",
    PHAROS_DATA_DIR: project.dataDir,
    // The CLI talks to the platform in-process; anchoring is explicit (`pharos anchor`/`demo`).
    PHAROS_TSA_ANCHOR_INTERVAL_MS: process.env.PHAROS_TSA_ANCHOR_INTERVAL_MS ?? "0",
    ...extra,
  };
  const config = loadConfig(env);
  return buildPlatform(config, { policyPacks: projectPolicies(project) });
}

export const resolveKeyName = (tenantId: string): string => `tenant:${tenantId}`;
