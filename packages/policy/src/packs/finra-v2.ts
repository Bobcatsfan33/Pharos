import type { PolicyArtifact } from "../rules.js";

/**
 * FINRA pack v2 — citation-level rules. Each rule names its clause and renders an
 * examiner-readable explanation into the verdict. (Reviewed by a securities-regulation
 * consultant is the external content gate.)
 */
export const FINRA_PACK_V2: PolicyArtifact = {
  packId: "finra",
  version: "2.0.0",
  title: "FINRA communications & supervision",
  changelog:
    "v2: citation-level 2210 promissory/disclosure rules; 3110 supervision; funds-movement.",
  rules: [
    {
      ruleId: "finra-2210-promissory",
      pack: "finra",
      clause: "FINRA Rule 2210(d)(1)(B)",
      description:
        "Communications may not be promissory or guarantee returns. The Tier-3 promissory judge flagged guaranteed/assured-return language, which 2210(d)(1)(B) prohibits.",
      when: { judge: "finra-promissory", gte: 0.5 },
      decision: "block",
    },
    {
      ruleId: "finra-2210-exaggerated",
      pack: "finra",
      clause: "FINRA Rule 2210(d)(1)(A)",
      description:
        "Communications must be fair and balanced and may not omit material facts or be misleading. High promissory-language probability indicates an exaggerated, unbalanced claim.",
      when: { judge: "finra-promissory", gte: 0.8 },
      decision: "block",
    },
    {
      ruleId: "finra-3110-funds-movement",
      pack: "finra",
      clause: "FINRA Rule 3110 (supervision) / 2150 (funds handling)",
      description:
        "Movement of customer funds requires supervisory review. Unmandated funds-movement intent is escalated to a registered principal under Rule 3110 supervision.",
      when: {
        all: [
          { judge: "funds-movement-intent", gte: 0.5 },
          { field: "liability.mandate", op: "eq", value: null },
        ],
      },
      decision: "escalate",
    },
    {
      ruleId: "finra-2150-large-transfer",
      pack: "finra",
      clause: "FINRA Rule 2150",
      description:
        "Large funds transfers require principal approval. Transfers above the threshold are escalated for registered-principal sign-off.",
      when: {
        all: [
          { field: "action.type", op: "startsWith", value: "payment." },
          { field: "liability.blastRadius.financialAmount", op: "gte", value: 50000 },
        ],
      },
      decision: "escalate",
    },
  ],
};
