export interface GatewayDurabilityConfig {
  pgUrl: string;
  masterKey: Buffer;
}

export interface GatewayServerConfig {
  env: string;
  apiBase: string;
  apiKey: string;
  tenantId: string;
  agentId: string;
  target: string;
  port: number;
  verdictDeadlineMs: number;
}

function parseUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain a query or fragment`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function parseInteger(name: string, value: string, minimum: number, maximum: number): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/**
 * Parse the gateway's network-facing configuration. Production never inherits local
 * endpoints, credentials, or tenant identifiers: every trust-boundary value must be
 * supplied explicitly by the deployment.
 */
export function loadGatewayServerConfig(env: NodeJS.ProcessEnv): GatewayServerConfig {
  const environment = env.PHAROS_ENV ?? "local";
  const production = ["prod", "production"].includes(environment);
  const required = (name: string, fallback: string): string => {
    const value = env[name]?.trim();
    if (value) return value;
    if (production) throw new Error(`production gateway requires ${name}`);
    return fallback;
  };

  return {
    env: environment,
    apiBase: parseUrl("PHAROS_API_BASE", required("PHAROS_API_BASE", "http://localhost:4000")),
    apiKey: required("PHAROS_API_KEY", ""),
    tenantId: required("PHAROS_TENANT", "default"),
    agentId: required("GATEWAY_AGENT_ID", "gateway-agent"),
    target: parseUrl("GATEWAY_TARGET", required("GATEWAY_TARGET", "http://localhost:8080")),
    port: parseInteger("GATEWAY_PORT", env.GATEWAY_PORT ?? "4100", 1, 65_535),
    verdictDeadlineMs: parseInteger(
      "PHAROS_VERDICT_DEADLINE_MS",
      env.PHAROS_VERDICT_DEADLINE_MS ?? "800",
      1,
      60_000,
    ),
  };
}

function decodeBase64Secret(value: string): Buffer {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw new Error("PHAROS_GATEWAY_HOLD_MASTER_KEY_B64 must be valid canonical base64");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error("PHAROS_GATEWAY_HOLD_MASTER_KEY_B64 must be valid canonical base64");
  }
  return decoded;
}

/**
 * Resolve the durable continuation configuration.
 *
 * Local/test composition may omit it and use the in-memory adapter. Both supported
 * production spellings fail closed unless the database and encryption key are present.
 */
export function loadGatewayDurabilityConfig(
  env: NodeJS.ProcessEnv,
): GatewayDurabilityConfig | null {
  const pgUrl = env.PHAROS_PG_URL;
  const encodedMasterKey = env.PHAROS_GATEWAY_HOLD_MASTER_KEY_B64;
  if (pgUrl && encodedMasterKey) {
    const masterKey = decodeBase64Secret(encodedMasterKey);
    if (masterKey.byteLength < 32) {
      throw new Error("PHAROS_GATEWAY_HOLD_MASTER_KEY_B64 must decode to at least 32 bytes");
    }
    return { pgUrl, masterKey };
  }
  if (["prod", "production"].includes(env.PHAROS_ENV ?? "")) {
    throw new Error(
      "production gateway requires PHAROS_PG_URL and PHAROS_GATEWAY_HOLD_MASTER_KEY_B64",
    );
  }
  return null;
}
