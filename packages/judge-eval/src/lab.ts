import { sha256Hex } from "@pharos/core";
import type { GateResult } from "./gate.js";

export interface DatasetProvenance {
  source: string;
  collectedAt: string;
  license: string;
  consentBasis?: string;
  containsPersonalData: boolean;
}

export interface AssuranceDataset {
  id: string;
  version: string;
  slices: string[];
  recordCount: number;
  provenance: DatasetProvenance;
  digest: string;
}

export interface DriftSignal {
  name: string;
  value: number;
  threshold: number;
  direction: "maximum" | "minimum";
}

export interface PromotionDecision {
  status: "promote" | "hold" | "rollback";
  candidateId: string;
  baselineId: string;
  reasons: string[];
  evaluatedAt: string;
  evidenceDigest: string;
}

export function registerDataset(input: Omit<AssuranceDataset, "digest">): AssuranceDataset {
  if (input.recordCount < 1 || input.slices.length < 1)
    throw new Error("assurance datasets require records and slices");
  if (!input.provenance.source || !input.provenance.license)
    throw new Error("dataset provenance and license are required");
  if (input.provenance.containsPersonalData && !input.provenance.consentBasis) {
    throw new Error("personal-data datasets require a consent or processing basis");
  }
  return { ...input, digest: sha256Hex(input) };
}

export function decidePromotion(input: {
  candidateId: string;
  baselineId: string;
  gate: GateResult;
  dataset: AssuranceDataset;
  driftSignals?: DriftSignal[];
  requiredApprovals?: number;
  approvalSubjects?: string[];
  currentChampion?: boolean;
  evaluatedAt?: string;
}): PromotionDecision {
  const reasons: string[] = [];
  if (!input.gate.pass) reasons.push("statistical evaluation gate failed");
  const drifted = (input.driftSignals ?? []).filter((signal) =>
    signal.direction === "maximum"
      ? signal.value > signal.threshold
      : signal.value < signal.threshold,
  );
  if (drifted.length)
    reasons.push(`drift thresholds exceeded: ${drifted.map((item) => item.name).join(", ")}`);
  const approvals = new Set(input.approvalSubjects ?? []).size;
  if (approvals < (input.requiredApprovals ?? 0))
    reasons.push(`requires ${input.requiredApprovals} independent approvals`);
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const status: PromotionDecision["status"] =
    reasons.length === 0 ? "promote" : input.currentChampion ? "rollback" : "hold";
  const decision = {
    status,
    candidateId: input.candidateId,
    baselineId: input.baselineId,
    reasons,
    evaluatedAt,
  };
  return {
    ...decision,
    evidenceDigest: sha256Hex({
      ...decision,
      datasetDigest: input.dataset.digest,
      gate: input.gate,
    }),
  };
}

export class AssuranceLab {
  private championId: string;
  private readonly history: PromotionDecision[] = [];

  constructor(championId: string) {
    this.championId = championId;
  }

  evaluate(
    input: Omit<Parameters<typeof decidePromotion>[0], "baselineId" | "currentChampion"> & {
      deployedCandidate?: boolean;
    },
  ): PromotionDecision {
    const decision = decidePromotion({
      ...input,
      baselineId: this.championId,
      currentChampion: input.deployedCandidate,
    });
    if (decision.status === "promote") this.championId = input.candidateId;
    this.history.push(decision);
    return decision;
  }

  champion(): string {
    return this.championId;
  }

  decisions(): readonly PromotionDecision[] {
    return this.history;
  }
}
