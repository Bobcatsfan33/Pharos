import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@pharos/core";
import { type Concern } from "./schema.js";
import { DATA_DIR } from "./loader.js";

/**
 * Frozen operating points (roadmap §7-10(e)). The committed thresholds are content-hashed; the
 * harness and the CI gate both bind to this hash so a threshold cannot silently move to flatter an
 * eval. Changing a threshold is a reviewed product decision + a new baseline, not a metric hack.
 */
export interface OperatingPoints {
  schemaVersion: string;
  frozenAt: string;
  note: string;
  thresholds: Record<Concern, number>;
}

export interface LoadedOperatingPoints {
  points: OperatingPoints;
  /** Content hash over the thresholds map (order-independent via canonical JSON). */
  hash: string;
}

export const OPERATING_POINTS_PATH = join(DATA_DIR, "operating-points.json");

export function operatingPointsHash(points: OperatingPoints): string {
  return sha256Hex(points.thresholds);
}

export function loadOperatingPoints(): LoadedOperatingPoints {
  const points = JSON.parse(readFileSync(OPERATING_POINTS_PATH, "utf8")) as OperatingPoints;
  return { points, hash: operatingPointsHash(points) };
}

export function thresholdFor(concern: Concern): number {
  return loadOperatingPoints().points.thresholds[concern];
}
