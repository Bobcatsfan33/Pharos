/**
 * Build a candidate, version-pinned drift profile from representative ONNX score JSONL.
 *
 * Input records contain ONLY:
 *   {"concern":"phi-in-context","judgeVersion":"phi-in-context@...","probability":0.42}
 *
 * The command prints JSON to stdout. It never accepts or copies prompt/action/tenant data:
 *   pnpm judges:drift-profile -- --input scores.jsonl > candidate-profile.json
 */
import { readFileSync } from "node:fs";
import { loadManifest } from "../packages/judge/src/index.js";
import {
  validateJudgeDriftProfile,
  type JudgeDriftProfile,
} from "../packages/observability/src/index.js";

const BIN_UPPER_BOUNDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`missing required --${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
}

interface ScoreRecord {
  concern: string;
  judgeVersion: string;
  probability: number;
}

function parseRecord(line: string, lineNumber: number): ScoreRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`line ${lineNumber}: invalid JSON`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["concern", "judgeVersion", "probability"].includes(key))
  ) {
    throw new Error(
      `line ${lineNumber}: only concern, judgeVersion, and probability are permitted`,
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.concern !== "string" ||
    typeof record.judgeVersion !== "string" ||
    typeof record.probability !== "number" ||
    !Number.isFinite(record.probability) ||
    record.probability < 0 ||
    record.probability > 1
  ) {
    throw new Error(`line ${lineNumber}: invalid score record`);
  }
  return record as unknown as ScoreRecord;
}

function main(): void {
  const input = argument("input");
  const minSamples = positiveInteger("min-samples", 1_000);
  const windowSize = positiveInteger("window-size", 10_000);
  const warningPsi = positiveNumber("warning-psi", 0.1);
  const criticalPsi = positiveNumber("critical-psi", 0.25);
  if (minSamples > windowSize) throw new Error("--min-samples must not exceed --window-size");
  if (warningPsi >= criticalPsi) throw new Error("--warning-psi must be less than --critical-psi");

  const manifest = loadManifest();
  const active = new Map(
    Object.entries(manifest.models).map(([concern, model]) => [model.modelVersion, concern]),
  );
  const grouped = new Map<string, { concern: string; bins: number[]; count: number }>();
  const lines = readFileSync(input, "utf8").split(/\r?\n/).filter(Boolean);
  lines.forEach((line, index) => {
    const record = parseRecord(line, index + 1);
    const expectedConcern = active.get(record.judgeVersion);
    if (!expectedConcern) {
      throw new Error(`line ${index + 1}: ${record.judgeVersion} is not active in the manifest`);
    }
    if (expectedConcern !== record.concern) {
      throw new Error(
        `line ${index + 1}: ${record.judgeVersion} belongs to ${expectedConcern}, not ${record.concern}`,
      );
    }
    const group = grouped.get(record.judgeVersion) ?? {
      concern: record.concern,
      bins: new Array(BIN_UPPER_BOUNDS.length).fill(0),
      count: 0,
    };
    const bin = BIN_UPPER_BOUNDS.findIndex((upper) => record.probability <= upper);
    group.bins[bin]! += 1;
    group.count += 1;
    grouped.set(record.judgeVersion, group);
  });

  const models: JudgeDriftProfile["models"] = {};
  for (const [version, group] of grouped) {
    if (group.count < minSamples) {
      throw new Error(`${version} has ${group.count} scores; at least ${minSamples} are required`);
    }
    models[version] = {
      concern: group.concern,
      referenceDistribution: group.bins.map((count) => count / group.count),
    };
  }
  for (const [version] of active) {
    if (!models[version]) throw new Error(`input is missing active model ${version}`);
  }

  const profile = validateJudgeDriftProfile({
    schemaVersion: "1.0.0",
    binUpperBounds: BIN_UPPER_BOUNDS,
    windowSize,
    minSamples,
    warningPsi,
    criticalPsi,
    models,
  });
  process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
