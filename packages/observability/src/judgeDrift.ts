import { readFileSync } from "node:fs";
import type { MetricsRegistry } from "./metrics.js";

export type DriftStatus = "warming" | "normal" | "warning" | "critical";

export interface JudgeObservation {
  concern: string;
  judgeVersion: string;
  probability: number;
  flagged: boolean;
}

export interface JudgeDriftModelProfile {
  concern: string;
  /** Probability mass for each bin declared by `binUpperBounds`; must sum to one. */
  referenceDistribution: number[];
}

export interface JudgeDriftProfile {
  schemaVersion: "1.0.0";
  /** Inclusive upper bounds. The final bound must be 1. */
  binUpperBounds: number[];
  /** Number of recent observations retained independently for each model version. */
  windowSize: number;
  /** No divergence decision is made before this many observations. */
  minSamples: number;
  warningPsi: number;
  criticalPsi: number;
  models: Record<string, JudgeDriftModelProfile>;
}

export interface JudgeDriftSnapshot {
  concern: string;
  judgeVersion: string;
  sampleCount: number;
  windowSize: number;
  psi: number | null;
  status: DriftStatus;
}

interface WindowState {
  bins: number[];
  queue: number[];
  next: number;
}

const PROFILE_SUM_TOLERANCE = 1e-6;
const PSI_EPSILON = 1e-6;
const STATUSES: DriftStatus[] = ["warming", "normal", "warning", "critical"];

/** Load and strictly validate a version-pinned production drift profile. */
export function loadJudgeDriftProfile(path: string): JudgeDriftProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`could not load judge drift profile ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return validateJudgeDriftProfile(raw);
}

export function validateJudgeDriftProfile(raw: unknown): JudgeDriftProfile {
  if (!isRecord(raw)) throw new Error("judge drift profile must be a JSON object");
  rejectUnknownKeys(
    raw,
    [
      "schemaVersion",
      "binUpperBounds",
      "windowSize",
      "minSamples",
      "warningPsi",
      "criticalPsi",
      "models",
    ],
    "judge drift profile",
  );
  if (raw.schemaVersion !== "1.0.0") {
    throw new Error('judge drift profile schemaVersion must be "1.0.0"');
  }

  const binUpperBounds = numberArray(raw.binUpperBounds, "binUpperBounds");
  if (
    binUpperBounds.length < 2 ||
    binUpperBounds[binUpperBounds.length - 1] !== 1 ||
    binUpperBounds.some(
      (bound, i) => bound <= 0 || bound > 1 || (i > 0 && bound <= binUpperBounds[i - 1]!),
    )
  ) {
    throw new Error("binUpperBounds must be strictly increasing in (0, 1] and end at 1");
  }

  const windowSize = positiveInteger(raw.windowSize, "windowSize");
  const minSamples = positiveInteger(raw.minSamples, "minSamples");
  if (minSamples > windowSize) throw new Error("minSamples must not exceed windowSize");
  const warningPsi = positiveNumber(raw.warningPsi, "warningPsi");
  const criticalPsi = positiveNumber(raw.criticalPsi, "criticalPsi");
  if (warningPsi >= criticalPsi) throw new Error("warningPsi must be less than criticalPsi");
  if (!isRecord(raw.models) || Object.keys(raw.models).length === 0) {
    throw new Error("models must contain at least one approved model-version profile");
  }

  const models: Record<string, JudgeDriftModelProfile> = {};
  for (const [version, value] of Object.entries(raw.models)) {
    if (
      !version.trim() ||
      !isRecord(value) ||
      typeof value.concern !== "string" ||
      !value.concern.trim()
    ) {
      throw new Error(`models.${version || "<empty>"} must declare a non-empty concern`);
    }
    rejectUnknownKeys(value, ["concern", "referenceDistribution"], `models.${version}`);
    const referenceDistribution = numberArray(
      value.referenceDistribution,
      `models.${version}.referenceDistribution`,
    );
    if (
      referenceDistribution.length !== binUpperBounds.length ||
      referenceDistribution.some((mass) => mass < 0 || mass > 1)
    ) {
      throw new Error(
        `models.${version}.referenceDistribution must have ${binUpperBounds.length} probabilities`,
      );
    }
    const sum = referenceDistribution.reduce((total, mass) => total + mass, 0);
    if (Math.abs(sum - 1) > PROFILE_SUM_TOLERANCE) {
      throw new Error(`models.${version}.referenceDistribution must sum to 1 (got ${sum})`);
    }
    models[version] = { concern: value.concern, referenceDistribution };
  }

  return {
    schemaVersion: "1.0.0",
    binUpperBounds,
    windowSize,
    minSamples,
    warningPsi,
    criticalPsi,
    models,
  };
}

/**
 * Bounded, in-process population-stability monitor.
 *
 * It retains only bin indexes (never prompts, action payloads, tenant IDs, or identities), so
 * monitoring does not create a second sensitive-data store. Each model version has an independent
 * rolling window; deployments must aggregate replica metrics and alert on the worst replica.
 */
export class JudgeDriftMonitor {
  private readonly states = new Map<string, WindowState>();
  private readonly missingVersions = new Set<string>();

  constructor(
    private readonly metrics: MetricsRegistry,
    private readonly profile: JudgeDriftProfile | null,
  ) {}

  assertModelsConfigured(models: Array<{ concern: string; judgeVersion: string }>): void {
    if (!this.profile) throw new Error("production judge drift profile is not configured");
    for (const model of models) {
      const configured = this.profile.models[model.judgeVersion];
      if (!configured) {
        throw new Error(`judge drift profile is missing active model ${model.judgeVersion}`);
      }
      if (configured.concern !== model.concern) {
        throw new Error(
          `judge drift profile maps ${model.judgeVersion} to ${configured.concern}, expected ${model.concern}`,
        );
      }
    }
  }

  observe(observation: JudgeObservation): JudgeDriftSnapshot | null {
    const probability = clampProbability(observation.probability);
    const labels = {
      concern: observation.concern,
      model_version: observation.judgeVersion,
    };
    this.metrics.judgeInferences.inc({ ...labels, flagged: String(observation.flagged) });
    this.metrics.judgeScores.observe(probability, labels);

    const configured = this.profile?.models[observation.judgeVersion];
    if (!configured || configured.concern !== observation.concern || !this.profile) {
      this.metrics.judgeDriftProfileReady.set(labels, 0);
      if (!this.missingVersions.has(observation.judgeVersion)) {
        this.metrics.judgeDriftProfileMissing.inc(labels);
        this.missingVersions.add(observation.judgeVersion);
      }
      return null;
    }

    this.metrics.judgeDriftProfileReady.set(labels, 1);
    const state: WindowState = this.states.get(observation.judgeVersion) ?? {
      bins: new Array(this.profile.binUpperBounds.length).fill(0),
      queue: [],
      next: 0,
    };
    const bin = this.profile.binUpperBounds.findIndex((upper) => probability <= upper);
    if (state.queue.length < this.profile.windowSize) {
      state.queue.push(bin);
    } else {
      const evicted = state.queue[state.next]!;
      state.bins[evicted]! -= 1;
      state.queue[state.next] = bin;
      state.next = (state.next + 1) % this.profile.windowSize;
    }
    state.bins[bin]! += 1;
    this.states.set(observation.judgeVersion, state);

    const sampleCount = state.queue.length;
    const psi =
      sampleCount >= this.profile.minSamples
        ? populationStabilityIndex(
            state.bins.map((count) => count / sampleCount),
            configured.referenceDistribution,
          )
        : null;
    const status: DriftStatus =
      psi === null
        ? "warming"
        : psi >= this.profile.criticalPsi
          ? "critical"
          : psi >= this.profile.warningPsi
            ? "warning"
            : "normal";

    this.metrics.judgeDriftSamples.set(labels, sampleCount);
    if (psi !== null) this.metrics.judgeDriftPsi.set(labels, psi);
    for (const candidate of STATUSES) {
      this.metrics.judgeDriftStatus.set(
        { ...labels, status: candidate },
        candidate === status ? 1 : 0,
      );
    }
    return {
      concern: observation.concern,
      judgeVersion: observation.judgeVersion,
      sampleCount,
      windowSize: this.profile.windowSize,
      psi,
      status,
    };
  }
}

export function populationStabilityIndex(actual: number[], expected: number[]): number {
  if (actual.length !== expected.length || actual.length === 0) {
    throw new Error("PSI distributions must be non-empty and have equal length");
  }
  return actual.reduce((sum, observed, index) => {
    const a = Math.max(observed, PSI_EPSILON);
    const e = Math.max(expected[index]!, PSI_EPSILON);
    return sum + (a - e) * Math.log(a / e);
  }, 0);
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) throw new Error("judge probability must be finite");
  return Math.max(0, Math.min(1, value));
}

function numberArray(value: unknown, name: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw new Error(`${name} must be an array of finite numbers`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${name} contains unknown field ${unknown[0]}`);
}
