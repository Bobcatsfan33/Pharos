import { type ResolvedItem, isDisagreement } from "./disagreement.js";

/**
 * Review-operations analytics. Pure functions over resolved items so the numbers are
 * testable and reproducible: review-time, SLA attainment, queue depth, reviewer throughput,
 * and the measured machine-vs-human disagreement rate.
 */
export interface ReviewRecord extends ResolvedItem {
  queue: string;
  createdAtMs: number;
  resolvedAtMs: number;
  slaDueAtMs: number;
  resolvedBy: string;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function medianReviewTimeMs(items: ReviewRecord[]): number {
  return median(items.map((i) => i.resolvedAtMs - i.createdAtMs));
}

/** Fraction of items resolved on or before their SLA deadline. */
export function slaAttainment(items: ReviewRecord[]): number {
  if (items.length === 0) return 1;
  const onTime = items.filter((i) => i.resolvedAtMs <= i.slaDueAtMs).length;
  return onTime / items.length;
}

export function throughputByReviewer(items: ReviewRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.resolvedBy] = (out[i.resolvedBy] ?? 0) + 1;
  return out;
}

export function disagreementRate(items: ResolvedItem[]): number {
  if (items.length === 0) return 0;
  return items.filter(isDisagreement).length / items.length;
}

export interface ReviewSummary {
  resolved: number;
  medianReviewTimeMs: number;
  slaAttainment: number;
  disagreementRate: number;
  byReviewer: Record<string, number>;
  byQueue: Record<string, number>;
}

export function summarize(items: ReviewRecord[]): ReviewSummary {
  const byQueue: Record<string, number> = {};
  for (const i of items) byQueue[i.queue] = (byQueue[i.queue] ?? 0) + 1;
  return {
    resolved: items.length,
    medianReviewTimeMs: medianReviewTimeMs(items),
    slaAttainment: slaAttainment(items),
    disagreementRate: disagreementRate(items),
    byReviewer: throughputByReviewer(items),
    byQueue,
  };
}
