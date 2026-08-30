import type { EffectConnector, EffectRequest } from "./effects.js";

export type PluginPermission =
  "network:outbound" | "credentials:request" | "effect:execute" | "effect:compensate";

export interface ConnectorPluginManifest {
  schemaVersion: "pharos.connector-plugin.v1";
  id: string;
  version: string;
  displayName: string;
  permissions: PluginPermission[];
  operations: string[];
}

export interface ConnectorPlugin {
  manifest: ConnectorPluginManifest;
  connector: EffectConnector;
}

export interface PluginConformanceCase {
  id: string;
  passed: boolean;
  detail: string;
}

export interface PluginConformanceResult {
  passed: boolean;
  cases: PluginConformanceCase[];
}

export async function runPluginConformance(
  plugin: ConnectorPlugin,
  request: EffectRequest,
): Promise<PluginConformanceResult> {
  const cases: PluginConformanceCase[] = [];
  const add = (id: string, passed: boolean, detail: string) => cases.push({ id, passed, detail });
  add("identity", plugin.manifest.id === plugin.connector.id, "manifest and connector ids match");
  add(
    "operation-declared",
    plugin.manifest.operations.includes(request.operation),
    `operation=${request.operation}`,
  );
  add(
    "execute-permission",
    plugin.manifest.permissions.includes("effect:execute"),
    "effect:execute permission declared",
  );
  try {
    const plan = await plugin.connector.plan(request);
    add(
      "plan-identity",
      plan.connectorId === plugin.manifest.id,
      `connectorId=${plan.connectorId}`,
    );
    add("input-digest", /^[0-9a-f]{64}$/.test(plan.inputDigest), "plan input is digest-bound");
    await plugin.connector.dryRun(plan, request);
    add("dry-run", true, "dry-run completed without an external effect");
  } catch (error) {
    add("plan-and-dry-run", false, (error as Error).message);
  }
  return { passed: cases.every((test) => test.passed), cases };
}
