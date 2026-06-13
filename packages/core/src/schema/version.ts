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
export const ACTION_RECORD_SCHEMA_VERSION = "1.0.0" as const;

export type SchemaVersion = typeof ACTION_RECORD_SCHEMA_VERSION;
