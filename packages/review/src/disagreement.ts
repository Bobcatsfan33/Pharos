/**
 * Machine-vs-human disagreement tracking and the feedback loop into policy.
 *
 * For each resolved escalation we compare the machine's risk lean with the human verdict.
 * Disagreement clusters (grouped by the dominant cited rule) become draft rule candidates
 * for the policy compiler — closing the human-feedback loop. The modeled 6.4% becomes a
 * measured rate over real review traffic.
 */
export interface ResolvedItem {
  escalationId: string;
  riskScore: number;
  /** ruleIds cited by the machine verdict. */
  citedRules: string[];
  dominantPack: string | null;
  humanDecision: "approve" | "modify" | "reject";
}

/** The machine "leaned toward stopping" when its risk score crossed 0.5. */
export function machineLeanedStop(item: { riskScore: number }): boolean {
  return item.riskScore >= 0.5;
}

export function isDisagreement(item: ResolvedItem): boolean {
  const humanStopped = item.humanDecision === "reject";
  return machineLeanedStop(item) !== humanStopped;
}

export interface RuleCandidate {
  ruleId: string;
  pack: string | null;
  disagreements: number;
  direction: "tighten" | "loosen";
  rationale: string;
}

/**
 * Cluster disagreements by dominant cited rule and emit draft rule candidates for clusters
 * at or above `minCluster`. If humans repeatedly approve what the machine flagged, the rule
 * is too tight (loosen); if humans repeatedly reject what the machine let lean-go, too loose.
 */
export function draftRuleCandidates(items: ResolvedItem[], minCluster = 3): RuleCandidate[] {
  const clusters = new Map<string, { pack: string | null; loosen: number; tighten: number }>();
  for (const item of items) {
    if (!isDisagreement(item)) continue;
    const key = item.citedRules[0] ?? item.dominantPack ?? "uncited";
    const entry = clusters.get(key) ?? { pack: item.dominantPack, loosen: 0, tighten: 0 };
    // Human approved a machine-flagged item -> loosen; human rejected a lean-go item -> tighten.
    if (machineLeanedStop(item) && item.humanDecision !== "reject") entry.loosen += 1;
    else entry.tighten += 1;
    clusters.set(key, entry);
  }
  const candidates: RuleCandidate[] = [];
  for (const [ruleId, c] of clusters) {
    const total = c.loosen + c.tighten;
    if (total < minCluster) continue;
    const direction = c.loosen >= c.tighten ? "loosen" : "tighten";
    candidates.push({
      ruleId,
      pack: c.pack,
      disagreements: total,
      direction,
      rationale:
        direction === "loosen"
          ? `Reviewers approved ${c.loosen}/${total} items this rule flagged — candidate to relax.`
          : `Reviewers rejected ${c.tighten}/${total} items this rule let lean-go — candidate to tighten.`,
    });
  }
  return candidates.sort((a, b) => b.disagreements - a.disagreements);
}
