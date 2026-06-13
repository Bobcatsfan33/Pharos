import { PDP_SPEC_VERSION, type PdpResponse } from "./contract.js";

/**
 * Dependency-free structural validator for a PDP response. Any vendor can run this without
 * pulling in a schema library; it mirrors the published JSON Schema.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const DECISIONS = ["allow", "block", "modify", "escalate"];
const TIERS = [1, 2, 3, "human"];

export function validatePdpResponse(obj: unknown): ValidationResult {
  const errors: string[] = [];
  const r = obj as Partial<PdpResponse>;
  if (!r || typeof r !== "object") return { valid: false, errors: ["response is not an object"] };

  if (r.specVersion !== PDP_SPEC_VERSION) errors.push(`specVersion must be ${PDP_SPEC_VERSION}`);
  if (!DECISIONS.includes(r.decision as string)) errors.push(`decision must be one of ${DECISIONS.join("|")}`);
  if (!TIERS.includes(r.tierReached as number | string)) errors.push("tierReached must be 1|2|3|'human'");
  if (typeof r.riskScore !== "number" || r.riskScore < 0 || r.riskScore > 1) errors.push("riskScore must be a number in [0,1]");
  if (!Array.isArray(r.ruleCitations)) errors.push("ruleCitations must be an array");
  else for (const c of r.ruleCitations) if (!c || typeof c.ruleId !== "string" || typeof c.pack !== "string") errors.push("each citation needs ruleId and pack");
  if (!(r.failMode === null || r.failMode === "fail_open" || r.failMode === "fail_closed")) errors.push("failMode must be null|fail_open|fail_closed");
  if (!(r.judgeVersion === null || typeof r.judgeVersion === "string")) errors.push("judgeVersion must be string|null");
  if (!r.latency || typeof r.latency.totalMs !== "number" || typeof r.latency.deadlineMs !== "number" || typeof r.latency.deadlineBreached !== "boolean") {
    errors.push("latency must be { totalMs:number, deadlineMs:number, deadlineBreached:boolean }");
  }
  if (r.evidenceBinding) {
    const b = r.evidenceBinding;
    if (b.algorithm !== "ed25519") errors.push("evidenceBinding.algorithm must be ed25519");
    if (typeof b.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(b.contentHash)) errors.push("evidenceBinding.contentHash must be 64-hex");
    if (typeof b.keyId !== "string" || typeof b.signature !== "string") errors.push("evidenceBinding needs keyId and signature");
  }
  return { valid: errors.length === 0, errors };
}
