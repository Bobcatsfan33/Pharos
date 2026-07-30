export interface GatewayDurabilityConfig {
  pgUrl: string;
  activeKeyId: string;
  masterKeys: Record<string, Buffer>;
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

function decodeBase64Secret(name: string, value: string): Buffer {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw new Error(`${name} must be valid canonical base64`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error(`${name} must be valid canonical base64`);
  }
  return decoded;
}

function parseMasterKey(name: string, value: string): Buffer {
  const masterKey = decodeBase64Secret(name, value);
  if (masterKey.byteLength < 32) {
    throw new Error(`${name} must decode to at least 32 bytes`);
  }
  return masterKey;
}

function parseKeyring(
  encoded: string,
  activeKeyId: string | undefined,
): {
  activeKeyId: string;
  masterKeys: Record<string, Buffer>;
} {
  if (!activeKeyId) {
    throw new Error("PHAROS_GATEWAY_HOLD_KEYS_B64 requires PHAROS_GATEWAY_HOLD_ACTIVE_KEY_ID");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(activeKeyId)) {
    throw new Error("PHAROS_GATEWAY_HOLD_ACTIVE_KEY_ID has an invalid format");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("PHAROS_GATEWAY_HOLD_KEYS_B64 must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PHAROS_GATEWAY_HOLD_KEYS_B64 must be a JSON object");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error("PHAROS_GATEWAY_HOLD_KEYS_B64 must contain between 1 and 16 keys");
  }
  const masterKeys: Record<string, Buffer> = {};
  for (const [keyId, value] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) {
      throw new Error(`gateway held-request key id has an invalid format: ${keyId}`);
    }
    if (typeof value !== "string") {
      throw new Error(`gateway held-request key must be base64 text: ${keyId}`);
    }
    masterKeys[keyId] = parseMasterKey(`gateway held-request key ${keyId}`, value);
  }
  if (!masterKeys[activeKeyId]) {
    throw new Error("PHAROS_GATEWAY_HOLD_ACTIVE_KEY_ID is not present in the key ring");
  }
  return { activeKeyId, masterKeys };
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
  const encodedKeyring = env.PHAROS_GATEWAY_HOLD_KEYS_B64;
  const activeKeyId = env.PHAROS_GATEWAY_HOLD_ACTIVE_KEY_ID;
  if (encodedMasterKey && (encodedKeyring || activeKeyId)) {
    throw new Error(
      "configure either PHAROS_GATEWAY_HOLD_MASTER_KEY_B64 or the versioned key ring, not both",
    );
  }
  if (pgUrl && encodedKeyring) {
    return { pgUrl, ...parseKeyring(encodedKeyring, activeKeyId) };
  }
  if (pgUrl && encodedMasterKey) {
    return {
      pgUrl,
      activeKeyId: "legacy",
      masterKeys: {
        legacy: parseMasterKey("PHAROS_GATEWAY_HOLD_MASTER_KEY_B64", encodedMasterKey),
      },
    };
  }
  if (encodedKeyring || activeKeyId || encodedMasterKey) {
    if (!pgUrl) {
      throw new Error("gateway held-request encryption requires PHAROS_PG_URL");
    }
  }
  if (["prod", "production"].includes(env.PHAROS_ENV ?? "")) {
    throw new Error(
      "production gateway requires PHAROS_PG_URL and a held-request encryption key ring",
    );
  }
  return null;
}
