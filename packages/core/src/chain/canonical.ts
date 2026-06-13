import { createHash } from "node:crypto";

/**
 * Deterministic canonical JSON serialization.
 *
 * The evidence chain and signatures hash record content, so two parties must
 * serialize the same content to identical bytes. We use a stable serialization:
 *   - object keys sorted lexicographically (UTF-16 code unit order, via Array#sort)
 *   - no insignificant whitespace
 *   - arrays preserve order
 *   - `undefined` properties are dropped (JSON has no undefined)
 *
 * This is intentionally simple and dependency-free so an external verifier can
 * reimplement it from the documented procedure.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("Cannot canonicalize non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "undefined" || t === "function") {
    throw new Error(`Cannot canonicalize value of type ${t}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v === undefined ? null : v)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Cannot canonicalize value of type ${t}`);
}

/** SHA-256 (lowercase hex) over the canonical JSON of `value`. */
export function sha256Hex(value: unknown): string {
  const canonical = canonicalize(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
