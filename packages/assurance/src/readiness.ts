import { type RecordSummary } from "./profile.js";

/**
 * The external-release readiness gate. Wired to live data: chain completeness, mandate
 * coverage, violation rate, and irreversibility controls. A failing check blocks an external
 * release unless an owner grants a recorded exception.
 */
export interface ReadinessCheck {
  id: string;
  description: string;
  value: number;
  threshold: number;
  comparator: "gte" | "lte";
  passed: boolean;
  excepted: boolean;
  owner?: string;
}

export interface ReadinessResult {
  passed: boolean;
  blocked: boolean;
  checks: ReadinessCheck[];
}

export interface ReadinessThresholds {
  minMandateCoverage: number; // gte
  maxViolationRate: number; // lte
  minIrreversibilityControl: number; // gte
}

export const DEFAULT_THRESHOLDS: ReadinessThresholds = {
  minMandateCoverage: 0.9,
  maxViolationRate: 0.3,
  minIrreversibilityControl: 0.9,
};

export function evaluateReadiness(
  records: RecordSummary[],
  chainComplete: boolean,
  thresholds: ReadinessThresholds = DEFAULT_THRESHOLDS,
  exceptions: Record<string, string> = {},
): ReadinessResult {
  const total = records.length || 1;
  const consequential = records.filter(
    (r) => r.financialAmount > 0 || r.reversibility === "irreversible",
  );
  const mandateCoverage =
    consequential.length === 0
      ? 1
      : consequential.filter((r) => r.mandatePresent).length / consequential.length;
  const violationRate = records.filter((r) => r.decision === "block").length / total;
  const irreversible = records.filter((r) => r.reversibility === "irreversible");
  const irreversibilityControl =
    irreversible.length === 0
      ? 1
      : irreversible.filter((r) => r.oversightMode !== "autonomous").length / irreversible.length;

  const raw: Array<Omit<ReadinessCheck, "passed" | "excepted">> = [
    {
      id: "chain-completeness",
      description: "Evidence chain verifies genesis-to-head",
      value: chainComplete ? 1 : 0,
      threshold: 1,
      comparator: "gte",
    },
    {
      id: "mandate-coverage",
      description: "Consequential actions are governed by a mandate",
      value: mandateCoverage,
      threshold: thresholds.minMandateCoverage,
      comparator: "gte",
    },
    {
      id: "violation-rate",
      description: "Policy-violation (block) rate is within tolerance",
      value: violationRate,
      threshold: thresholds.maxViolationRate,
      comparator: "lte",
    },
    {
      id: "irreversibility-controls",
      description: "Irreversible actions have human oversight",
      value: irreversibilityControl,
      threshold: thresholds.minIrreversibilityControl,
      comparator: "gte",
    },
  ];

  const checks: ReadinessCheck[] = raw.map((c) => {
    const meets = c.comparator === "gte" ? c.value >= c.threshold : c.value <= c.threshold;
    const excepted = !meets && exceptions[c.id] !== undefined;
    return { ...c, passed: meets || excepted, excepted, owner: exceptions[c.id] };
  });

  const passed = checks.every((c) => c.passed);
  return { passed, blocked: !passed, checks };
}
