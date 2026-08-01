/**
 * The unified ActionRecord schema version.
 *
 * Sprint 0 freezes v1.0.0. The schema is versioned explicitly from day one: every
 * persisted record carries this string, and migration adapters translate legacy
 * shapes (Flightline liability records, AI Lighthouse verdict records) into it.
 *
 * Bumping rules:
 *   - PATCH: additive optional field, no migration required.
 *   - MINOR: additive required field with a default migration.
 *   - MAJOR: breaking change; requires a forward migration adapter and a documented
 *            re-verification procedure for the evidence chain.
 */
export const ACTION_RECORD_SCHEMA_VERSION = "1.1.0" as const;

export type SchemaVersion = typeof ACTION_RECORD_SCHEMA_VERSION;

/**
 * Versions this codebase can read. Records sealed under any of these verify; only the
 * CURRENT version is written. v1.0.0 records are never rewritten (ADR 0005 D2).
 */
export const SUPPORTED_SCHEMA_VERSIONS = ["1.0.0", "1.1.0"] as const;

/**
 * First version in which `seal.algorithm` is required to state the real signing
 * algorithm, and is therefore checked against the keyset entry (ADR 0005 D3).
 * Below this, the field is informational only.
 */
export const SEAL_ALGORITHM_TRUTHFUL_FROM = "1.1.0" as const;

/** Compare dotted numeric versions. Returns <0, 0, >0. */
export function compareSchemaVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * True when a record's `seal.algorithm` must agree with the keyset entry.
 *
 * The gating marker is itself authenticated: `schemaVersion` lives inside `content`,
 * which is hashed and signed, so a v1.1 record cannot be downgraded to dodge the check
 * without breaking its signature.
 */
export function sealAlgorithmIsAuthoritative(schemaVersion: string): boolean {
  return compareSchemaVersions(schemaVersion, SEAL_ALGORITHM_TRUTHFUL_FROM) >= 0;
}
