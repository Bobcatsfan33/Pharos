import { type ConcernReport } from "./report.js";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (lo: number, hi: number) => `[${pct(lo)}, ${pct(hi)}]`;

export interface ReportMeta {
  generatedNote: string;
  operatingPointsHash: string;
  datasetHashes: Record<string, string>;
  humanReviewStatus: string;
  generatorIdentity: string;
  sharedFamilyLimitation: string;
}

/** Render the full honest benchmark report (roadmap S5-T2/T3). PR-AUC leads; the base-rate box is
 *  unmistakable; controls and CIs are always shown. */
export function renderMarkdown(reports: ConcernReport[], meta: ReportMeta): string {
  const L: string[] = [];
  L.push("# Tier-3 judge evaluation — honest baseline\n");
  L.push(
    "> **Read the base-rate box before any precision number.** Precision on a balanced eval set is *not* operational precision. PR-AUC is the lead ranking metric; ROC-AUC is secondary. All intervals are 95% (Wilson for proportions, seeded stratified bootstrap for derived metrics).\n",
  );
  L.push(`_${meta.generatedNote}_\n`);
  L.push("## Provenance\n");
  L.push(
    `- **Operating points (frozen):** hash \`${meta.operatingPointsHash.slice(0, 16)}…\` (threshold 0.5 per concern).`,
  );
  L.push(`- **Generator:** ${meta.generatorIdentity}`);
  L.push(`- **Human review:** ${meta.humanReviewStatus}`);
  L.push(`- **Shared-generator-family limitation:** ${meta.sharedFamilyLimitation}`);
  L.push("- **Dataset hashes:**");
  for (const [c, h] of Object.entries(meta.datasetHashes))
    L.push(`  - ${c}: \`${h.slice(0, 16)}…\``);
  L.push("");

  for (const r of reports) {
    L.push(`## ${r.concern}\n`);
    L.push(
      `Scorer: \`${r.scorer}\` · threshold \`${r.threshold}\` · operating-points \`${r.operatingPointsHash.slice(0, 12)}…\`\n`,
    );

    // Base-rate box — visually unmistakable.
    const br = r.baseRate;
    L.push("### ⚠️ Base-rate box\n");
    L.push("| | value |");
    L.push("|---|---|");
    L.push(`| Eval prevalence | ${pct(br.evalPrevalence)} (balanced) |`);
    L.push(
      `| Production prevalence | ${br.productionPrevalence === null ? "**unknown** — scenarios below" : pct(br.productionPrevalence)} |`,
    );
    L.push(`| Rationale | ${br.productionPrevalenceRationale} |`);
    if (br.adjustedPrecision !== null)
      L.push(`| Adjusted precision @ production prevalence | ${pct(br.adjustedPrecision)} |`);
    L.push("");
    L.push("| Prevalence scenario | Adjusted precision (PPV) |");
    L.push("|---|---|");
    for (const s of br.scenarios) L.push(`| ${pct(s.prevalence)} | ${pct(s.adjustedPrecision)} |`);
    L.push("");

    // Clean metrics.
    const c = r.clean;
    L.push("### Clean split\n");
    L.push("| Metric | Value | 95% CI |");
    L.push("|---|---|---|");
    L.push(`| **PR-AUC (lead)** | ${pct(c.prAuc)} | ${ci(c.prAucCI.lower, c.prAucCI.upper)} |`);
    L.push(`| ROC-AUC | ${pct(c.rocAuc)} | ${ci(c.rocAucCI.lower, c.rocAucCI.upper)} |`);
    L.push(
      `| Precision @ ${r.threshold} | ${pct(c.precision)} | ${ci(c.precisionCI.lower, c.precisionCI.upper)} |`,
    );
    L.push(
      `| Recall @ ${r.threshold} | ${pct(c.recall)} | ${ci(c.recallCI.lower, c.recallCI.upper)} |`,
    );
    L.push(`| F1 @ ${r.threshold} | ${pct(c.f1)} | ${ci(c.f1CI.lower, c.f1CI.upper)} |`);
    L.push(`| FPR @ ${r.threshold} | ${pct(c.fpr)} | ${ci(c.fprCI.lower, c.fprCI.upper)} |`);
    L.push(`| ECE (calibration) | ${pct(c.ece)} | ${ci(c.eceCI.lower, c.eceCI.upper)} |`);
    L.push(
      `| Hard-negative FPR | ${pct(r.hardNegatives.falsePositiveRate)} | ${ci(r.hardNegatives.falsePositiveRateCI.lower, r.hardNegatives.falsePositiveRateCI.upper)} |`,
    );
    L.push("");

    // Adversarial degradation.
    L.push("### Adversarial suites — recall & degradation vs clean\n");
    L.push(`Clean recall = ${pct(c.recall)}.\n`);
    L.push("| Suite | n | Recall | 95% CI | Degradation |");
    L.push("|---|---|---|---|---|");
    for (const a of r.adversarial)
      L.push(
        `| ${a.suite} (${a.lang}) | ${a.count} | ${pct(a.recall)} | ${ci(a.recallCI.lower, a.recallCI.upper)} | ${pct(a.degradationVsClean)} |`,
      );
    L.push("");

    // Controls.
    L.push("### Negative controls (legible floors)\n");
    L.push("| Control | Clean recall | PR-AUC | ROC-AUC |");
    L.push("|---|---|---|---|");
    for (const ctl of r.controls)
      L.push(`| ${ctl.name} | ${pct(ctl.cleanRecall)} | ${pct(ctl.prAuc)} | ${pct(ctl.rocAuc)} |`);
    L.push("");
  }
  return L.join("\n");
}
