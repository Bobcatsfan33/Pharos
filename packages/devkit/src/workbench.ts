import { sha256Hex, type VerdictDecision, type VerdictRequest } from "@pharos/core";
import { decideWith, type EvalContext, type PolicyArtifact } from "@pharos/policy";

export interface WorkbenchCase {
  id: string;
  request: VerdictRequest;
  judgeProbabilities?: Record<string, number>;
  expected?: VerdictDecision;
}

export interface SimulationResult {
  id: string;
  decision: VerdictDecision;
  expected: VerdictDecision | null;
  passed: boolean | null;
  requestDigest: string;
}

export interface ImpactReport {
  total: number;
  changed: number;
  transitions: Record<string, number>;
  examples: Array<{ id: string; from: VerdictDecision; to: VerdictDecision }>;
}

function context(test: WorkbenchCase): EvalContext {
  return { request: test.request, judgeProbabilities: test.judgeProbabilities ?? {} };
}

export function simulatePolicy(
  artifact: PolicyArtifact,
  cases: WorkbenchCase[],
): SimulationResult[] {
  return cases.map((test) => {
    const decision = decideWith(artifact, context(test));
    return {
      id: test.id,
      decision,
      expected: test.expected ?? null,
      passed: test.expected ? decision === test.expected : null,
      requestDigest: sha256Hex(test.request),
    };
  });
}

export function diffPolicies(
  baseline: PolicyArtifact,
  candidate: PolicyArtifact,
  cases: WorkbenchCase[],
  exampleLimit = 20,
): ImpactReport {
  const transitions: Record<string, number> = {};
  const examples: ImpactReport["examples"] = [];
  let changed = 0;
  for (const test of cases) {
    const from = decideWith(baseline, context(test));
    const to = decideWith(candidate, context(test));
    const key = `${from}->${to}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
    if (from !== to) {
      changed += 1;
      if (examples.length < exampleLimit) examples.push({ id: test.id, from, to });
    }
  }
  return { total: cases.length, changed, transitions, examples };
}

const SECRET_KEYS = /^(authorization|cookie|password|secret|token|api[_-]?key)$/i;

/** Produce a deterministic, shareable fixture without copying credentials from production. */
export function sanitizeFixture(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeFixture);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    out[key] = SECRET_KEYS.test(key) ? "[REDACTED]" : sanitizeFixture(item);
  }
  return out;
}

export interface DoctorCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export function runDoctor(input: {
  nodeVersion: string;
  pharosUrl?: string;
  apiKey?: string;
}): DoctorCheck[] {
  const major = Number(input.nodeVersion.replace(/^v/, "").split(".")[0]);
  const checks: DoctorCheck[] = [
    { id: "node", passed: Number.isInteger(major) && major >= 20, detail: input.nodeVersion },
    {
      id: "url",
      passed: Boolean(input.pharosUrl && /^https?:\/\//.test(input.pharosUrl)),
      detail: input.pharosUrl ?? "PHAROS_URL is not set",
    },
    {
      id: "credentials",
      passed: Boolean(input.apiKey),
      detail: input.apiKey ? "credential configured" : "PHAROS_API_KEY is not set",
    },
  ];
  return checks;
}
