/**
 * Generate the served-judge model cards (WS6 / roadmap S6-T3).
 *
 *   pnpm judges:cards
 *
 * Reads packages/judge/models/manifest.json so each card's `Version:` and artifact digests stay in
 * sync with the SERVED artifact — the readiness gate refuses to serve a pack whose card version does
 * not match its current model version. Served numbers are the TRUE batch-1 (serving-faithful)
 * figures, not the optimistic batch-32 eval-harness numbers.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const MODELS_DIR = fileURLToPath(new URL("../packages/judge/models", import.meta.url));
const manifest = JSON.parse(readFileSync(join(MODELS_DIR, "manifest.json"), "utf8")) as {
  release: { repo: string; tag: string };
  models: Record<
    string,
    {
      modelVersion: string;
      served: string;
      baseModel: string;
      threshold: number;
      assets: { model: { asset: string; sha256: string }; tokenizer: { sha256: string } };
    }
  >;
};

interface CardData {
  title: string;
  authority: string;
  intended: string;
  cleanRecall: string;
  hardNegFpr: string;
  semanticWon: string;
  limitations: string;
}

const DATA: Record<string, CardData> = {
  "finra-promissory": {
    title: "FINRA promissory-language judge",
    authority: "FINRA Rule 2210(d)(1)(B) — no guarantees / exaggerated or promissory claims.",
    intended:
      "Tier-3 semantic detection of promissory / guarantee / no-risk language in communications.",
    cleanRecall: "97.0%",
    hardNegFpr: "11.1%",
    semanticWon: "7/7 (paraphrase, synonym, leetspeak, sentence-split, prompt-injection, es, de)",
    limitations:
      "Strongest of the three. base64/rot13/homoglyph are handled by the cascade normalizer (SYSTEM), not the bare model, and the bare model over-flags encoded/OOD input — see docs/benchmarks/system-encoding-eval.md and ADR 0004.",
  },
  "funds-movement-intent": {
    title: "Funds-movement-intent judge",
    authority: "Payment-operations executable-intent control framing (SR 11-7 control material).",
    intended:
      "Tier-3 semantic detection of executable instructions to move money now (wire/ACH/payment).",
    cleanRecall: "100%",
    hardNegFpr: "36.3%",
    semanticWon: "6/7 (paraphrase excepted — see limitations)",
    limitations:
      'Known weakness (#91): meta-framed instructions ("what this really means is that … the bottom line") fool the intent detector — the paraphrase suite regresses vs the keyword-matching logistic. Adjudicated as valid labels, so this is a model weakness scheduled as a recipe-revision follow-up, NOT a labeling error. Hard-negative FPR (36.3%) is the highest of the three but far below the logistic baseline (82.5%).',
  },
  "phi-in-context": {
    title: "PHI-in-context judge",
    authority: "HIPAA Privacy Rule, 45 CFR §160.103 / §164.514(b) Safe Harbor.",
    intended:
      "Tier-3 semantic detection of Protected Health Information (identifier + health information).",
    cleanRecall: "100%",
    hardNegFpr: "16.0%",
    semanticWon: "7/7",
    limitations:
      "Served fp32, not int8: int8 dynamic-quantization recalibration could not hold hard-negative FPR within the +3% gate tolerance on the lockbox, so this pack ships fp32 (516MB). That yields a ~14s cold-load (sha256 re-verify of the fp32 blob + session create) — a boot-time cost addressed in S7-T1 (static/QDQ int8). Warm inference is within the 800ms envelope.",
  },
};

for (const [concern, entry] of Object.entries(manifest.models)) {
  const d = DATA[concern]!;
  const quant = entry.served === "model.int8.onnx" ? "dynamic int8" : "fp32 (batch-invariant)";
  const card = `# Model card — ${d.title}

- **Pack:** \`${concern}\`
- **Version:** \`${entry.modelVersion}\` (content hash; the readiness gate refuses to serve a pack whose card version ≠ its served version)
- **Base model:** ${entry.baseModel} (135M params, CPU-served)
- **Quantization:** ${quant} · **served asset:** \`${entry.served}\` · **operating threshold:** ${entry.threshold} (frozen, content-hashed)
- **Grounding authority:** ${d.authority}

## Intended use

${d.intended} One of three Tier-3 judges behind the deterministic cascade. **Not** a standalone
compliance decision — it produces a calibrated probability the cascade cites; a human reviews
escalations. Served **batch-1** for reproducible, replay-identical verdicts (PR #94).

## Data provenance

Fine-tuned from ${entry.baseModel} on a training corpus authored for this task (\`training/\`), with
surface forms **disjoint from the eval/lockbox splits** (n-gram leakage gate proven, Amendment 10).
Labels are grounded in cited authority (above), not model-inferred. Multilingual so the Spanish/German
("translation") suites are addressable. Temperature-scaling calibration on a held-out split.

## Measured served numbers (batch-1, lockbox, threshold ${entry.threshold})

The TRUE serving-faithful figures (not the optimistic batch-32 eval-harness numbers).

| metric | value |
|---|---|
| clean recall | **${d.cleanRecall}** |
| hard-negative FPR | ${d.hardNegFpr} |
| semantic suites beaten vs logistic baseline | ${d.semanticWon} |

**Base-rate honesty:** the eval set is balanced (50%); production prevalence is unknown, so a headline
precision is not an operational forecast. Full curves, CIs, and controls: \`docs/benchmarks/judge-evals.md\`.

## Known limitations / failure modes

${d.limitations}

The cascade normalizer (ADR 0004) canonicalizes/decodes obfuscated input in front of this bare model;
encoding (base64/rot13/homoglyph) is a SYSTEM property, never a model win.

## Artifact digests (fetched hash-verified from the Release, ${manifest.release.tag})

- model \`${entry.served}\`: \`sha256:${entry.assets.model.sha256}\`
- tokenizer.json: \`sha256:${entry.assets.tokenizer.sha256}\`

_Generated by \`pnpm judges:cards\` from packages/judge/models/manifest.json — do not hand-edit._
`;
  const path = join(MODELS_DIR, `${concern}.CARD.md`);
  writeFileSync(path, card, "utf8");
  console.log(`wrote ${concern}.CARD.md (${entry.modelVersion})`);
}
