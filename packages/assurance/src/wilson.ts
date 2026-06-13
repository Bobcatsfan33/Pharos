/**
 * Wilson score confidence interval for a binomial proportion.
 *
 * The assurance engine samples unreviewed verdicts into human audits; the fraction the
 * human upholds is the measured accuracy. We report the Wilson *lower* bound at 95%
 * confidence — a statistically honest "verified accuracy is at least X" — which replaces the
 * modeled placeholder. The lower bound is conservative for small samples and tightens as the
 * audit count grows (the reason the exit bar is ≥1,000 real audits).
 */
export const Z_95 = 1.959963984540054;

export interface WilsonInterval {
  point: number;
  lower: number;
  upper: number;
  n: number;
  confidence: number;
}

export function wilsonInterval(successes: number, n: number, z: number = Z_95): WilsonInterval {
  if (n === 0) return { point: 0, lower: 0, upper: 0, n: 0, confidence: 0.95 };
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return {
    point: phat,
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
    n,
    confidence: 0.95,
  };
}

/** Convenience: the lower bound only. */
export function wilsonLowerBound(successes: number, n: number, z: number = Z_95): number {
  return wilsonInterval(successes, n, z).lower;
}
