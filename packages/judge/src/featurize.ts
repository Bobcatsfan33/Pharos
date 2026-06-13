/**
 * Deterministic text featurization for the distilled judge models.
 *
 * Lowercased unigrams + bigrams over alphanumeric tokens. Intentionally simple and
 * dependency-free so inference is identical across the served path and the reproducibility
 * harness (the same text always yields the same features and therefore the same verdict).
 *
 * This is feature extraction for a learned linear model — not regex pattern matching. The
 * model's weights, not hand-written patterns, decide what matters.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export function featurize(text: string): string[] {
  const tokens = tokenize(text);
  const features: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    features.push(`u:${tokens[i]}`);
    if (i + 1 < tokens.length) features.push(`b:${tokens[i]}_${tokens[i + 1]}`);
  }
  return features;
}

/** Bag-of-features counts (a feature may occur multiple times). */
export function featureCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of featurize(text)) counts.set(f, (counts.get(f) ?? 0) + 1);
  return counts;
}
