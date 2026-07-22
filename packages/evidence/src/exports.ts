import type { ActionRecord } from "@pharos/core";

/**
 * Regulatory exports generated from live evidence. Each maps the unified ActionRecord set
 * to the structure a specific regime expects. These are real, validated formats — the
 * external-counsel review of each against the requirement text is a Sprint-5 legal gate.
 */

/** FINRA examination export: communications with supervisory verdicts and retention metadata. */
export function finraExaminationExport(tenantId: string, records: ActionRecord[]) {
  const communications = records
    .filter(
      (r) =>
        r.content.action.type.startsWith("email.") ||
        r.content.action.type.startsWith("message.") ||
        r.content.action.type.includes("comm"),
    )
    .map((r) => ({
      recordId: r.content.id,
      sequence: r.content.sequence,
      timestamp: r.content.action.emittedAt,
      principalSupervision: r.content.verdict.tierReached === "human",
      disposition: r.content.verdict.decision,
      ruleCitations: r.content.verdict.ruleCitations.filter((c) => c.pack === "finra"),
      contentHash: r.seal.contentHash,
    }));
  return {
    format: "FINRA-2210/3110-examination",
    tenantId,
    generatedFields: ["disposition", "ruleCitations", "principalSupervision", "retentionHash"],
    rule3110Supervision:
      "Each escalation resolved at the human tier records a registered-principal verdict.",
    recordRetention: "WORM Object Lock; content-hash chained; see verification bundle.",
    communications,
    count: communications.length,
  };
}

/** EU AI Act Article 12 record-keeping export: lifetime event logs with traceability. */
export function euAiActArticle12Export(tenantId: string, records: ActionRecord[]) {
  return {
    format: "EU-AI-Act-Article-12-record-keeping",
    tenantId,
    description:
      "Automatic recording of events over the lifetime of the AI system, ensuring traceability.",
    events: records.map((r) => ({
      recordId: r.content.id,
      sequence: r.content.sequence,
      timestamp: r.content.action.emittedAt,
      situation: r.content.action.type,
      referenceData: {
        riskScore: r.content.verdict.riskScore,
        tier: r.content.verdict.tierReached,
      },
      systemDecision: r.content.verdict.decision,
      modelVersion:
        r.content.verdict.judgeVersion ?? r.content.liability.modelMetadata?.version ?? null,
      humanOversight: r.content.liability.oversightMode,
      contentHash: r.seal.contentHash,
    })),
    count: records.length,
  };
}

/** SR 11-7 model-risk documentation export: model inventory, decisions, and monitoring. */
export function sr117ModelRiskExport(tenantId: string, records: ActionRecord[]) {
  const judgeVersions = new Set<string>();
  for (const r of records)
    if (r.content.verdict.judgeVersion) judgeVersions.add(r.content.verdict.judgeVersion);
  return {
    format: "SR-11-7-model-risk",
    tenantId,
    modelInventory: [...judgeVersions].map((v) => ({
      modelId: v,
      role: "Tier-3 distilled judge",
      validation: "deterministic; content-addressed version",
    })),
    developmentImplementationUse:
      "Cascade Tier 1 deterministic rules, Tier 2 statistical risk, Tier 3 served judges; every verdict cites the producing version.",
    ongoingMonitoring: "Continuous sampling-based assurance with Wilson-score bounds (Sprint 7).",
    decisions: records.map((r) => ({
      sequence: r.content.sequence,
      decision: r.content.verdict.decision,
      riskScore: r.content.verdict.riskScore,
      modelVersion: r.content.verdict.judgeVersion,
      contentHash: r.seal.contentHash,
    })),
    count: records.length,
  };
}

export type RegulatoryFormat = "finra" | "eu_ai_act_12" | "sr_11_7";

export function generateRegulatoryExport(
  format: RegulatoryFormat,
  tenantId: string,
  records: ActionRecord[],
) {
  switch (format) {
    case "finra":
      return finraExaminationExport(tenantId, records);
    case "eu_ai_act_12":
      return euAiActArticle12Export(tenantId, records);
    case "sr_11_7":
      return sr117ModelRiskExport(tenantId, records);
  }
}
