import { PdpResponseSchema } from "./schema.js";

/**
 * Structural validation of a PDP response against the contract schema — the same zod
 * definitions the published JSON Schema is generated from, so a response that passes here
 * validates against `schema/pdp-v1.schema.json` and vice versa. Vendors without this package
 * validate against the JSON Schema directly.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePdpResponse(obj: unknown): ValidationResult {
  if (!obj || typeof obj !== "object") {
    return { valid: false, errors: ["response is not an object"] };
  }
  const parsed = PdpResponseSchema.safeParse(obj);
  if (parsed.success) return { valid: true, errors: [] };
  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { valid: false, errors };
}
