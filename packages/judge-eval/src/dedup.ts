/**
 * Similarity-based leakage detection (roadmap §7-10(d)): normalized exact matching is necessary
 * but insufficient. We block feature-aligned n-gram overlap between eval and training examples.
 *
 * Blocking defaults (from S5-T1): token-bigram containment ≥ 0.80 OR token-trigram Jaccard ≥ 0.50.
 * Tokenization mirrors the judge's featurizer (lowercased alphanumeric tokens) so "feature-aligned"
 * is literal. An optional pinned-embedding review is a *secondary* defense; the n-gram gate is
 * mandatory and runs even without embeddings.
 */
export const BIGRAM_CONTAINMENT_BLOCK = 0.8;
export const TRIGRAM_JACCARD_BLOCK = 0.5;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function ngrams(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(" "));
  return out;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let c = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) c++;
  return c;
}

/** Fraction of `a`'s n-grams also present in `b` (containment of a in b). */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  return intersectionSize(a, b) / a.size;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const inter = intersectionSize(a, b);
  return inter / (a.size + b.size - inter);
}

export interface LeakageHit {
  evalId: string;
  evalText: string;
  trainText: string;
  bigramContainment: number;
  trigramJaccard: number;
  reason: "exact" | "bigram-containment" | "trigram-jaccard";
}

export interface LeakageReport {
  checked: number;
  trainCount: number;
  exactMatches: number;
  hits: LeakageHit[];
  /** Nearest train example per eval record's max bigram containment, worst-first (top 20). */
  nearest: Array<{ evalId: string; bigramContainment: number; trigramJaccard: number }>;
  /** Distribution of max bigram containment across eval records (bucketed). */
  distribution: Record<string, number>;
}

interface EvalRec {
  id: string;
  text: string;
}

/**
 * Compare every eval record against every training record. A hit is a normalized-exact match OR
 * bigram containment ≥ 0.80 OR trigram Jaccard ≥ 0.50. Returns hits + nearest pairs + distribution.
 */
export function detectLeakage(
  evalRecords: EvalRec[],
  trainTexts: string[],
  opts: { bigramBlock?: number; trigramBlock?: number } = {},
): LeakageReport {
  const bigramBlock = opts.bigramBlock ?? BIGRAM_CONTAINMENT_BLOCK;
  const trigramBlock = opts.trigramBlock ?? TRIGRAM_JACCARD_BLOCK;

  const trainNorm = trainTexts.map((t) => ({
    norm: tokenize(t).join(" "),
    big: ngrams(tokenize(t), 2),
    tri: ngrams(tokenize(t), 3),
    text: t,
  }));

  const hits: LeakageHit[] = [];
  const nearest: LeakageReport["nearest"] = [];
  const distribution: Record<string, number> = {
    "0.0-0.2": 0,
    "0.2-0.4": 0,
    "0.4-0.6": 0,
    "0.6-0.8": 0,
    "0.8-1.0": 0,
  };
  let exactMatches = 0;

  for (const rec of evalRecords) {
    const toks = tokenize(rec.text);
    const norm = toks.join(" ");
    const big = ngrams(toks, 2);
    const tri = ngrams(toks, 3);

    let bestBig = 0;
    let bestTri = 0;
    let bestTrainText = "";
    let exact = false;

    for (const tr of trainNorm) {
      if (tr.norm === norm && norm.length > 0) {
        exact = true;
        bestBig = 1;
        bestTri = 1;
        bestTrainText = tr.text;
        break;
      }
      const bc = containment(big, tr.big);
      const tj = jaccard(tri, tr.tri);
      if (bc > bestBig) {
        bestBig = bc;
        bestTrainText = tr.text;
      }
      if (tj > bestTri) bestTri = tj;
    }

    if (exact) {
      exactMatches++;
      hits.push({
        evalId: rec.id,
        evalText: rec.text,
        trainText: bestTrainText,
        bigramContainment: 1,
        trigramJaccard: 1,
        reason: "exact",
      });
    } else if (bestBig >= bigramBlock) {
      hits.push({
        evalId: rec.id,
        evalText: rec.text,
        trainText: bestTrainText,
        bigramContainment: bestBig,
        trigramJaccard: bestTri,
        reason: "bigram-containment",
      });
    } else if (bestTri >= trigramBlock) {
      hits.push({
        evalId: rec.id,
        evalText: rec.text,
        trainText: bestTrainText,
        bigramContainment: bestBig,
        trigramJaccard: bestTri,
        reason: "trigram-jaccard",
      });
    }

    nearest.push({ evalId: rec.id, bigramContainment: bestBig, trigramJaccard: bestTri });
    const bucket =
      bestBig >= 0.8
        ? "0.8-1.0"
        : bestBig >= 0.6
          ? "0.6-0.8"
          : bestBig >= 0.4
            ? "0.4-0.6"
            : bestBig >= 0.2
              ? "0.2-0.4"
              : "0.0-0.2";
    distribution[bucket]!++;
  }

  nearest.sort((a, b) => b.bigramContainment - a.bigramContainment);
  return {
    checked: evalRecords.length,
    trainCount: trainTexts.length,
    exactMatches,
    hits,
    nearest: nearest.slice(0, 20),
    distribution,
  };
}
