export interface GatewayDurabilityConfig {
  pgUrl: string;
  masterKey: Buffer;
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
