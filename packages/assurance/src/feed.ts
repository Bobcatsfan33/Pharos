import { type RiskProfileV2 } from "./profile.js";
import { type WilsonInterval } from "./wilson.js";

/**
 * The underwriter feed — a versioned, consent-gated risk-profile export co-designed with
 * carriers/MGAs. Feed changes are versioned like an API so a carrier can pin a schema. This
 * is the BitSight-of-AI-liability signal: it converts Pharos from a control into a pricing
 * input.
 */
export const UNDERWRITER_FEED_VERSION = "1.0";

export interface UnderwriterFeed {
  feedVersion: string;
  tenantId: string;
  generatedAt: string;
  /** The metrics carriers said move premium (co-designed). */
  posture: {
    autonomyRate: number;
    irreversibleMix: number;
    policyFailureRate: number;
    oversightCoverage: number;
    maxBlastRadius: number;
  };
  assurance: {
    verifiedAccuracyLowerBound: number;
    sampleSize: number;
    confidence: number;
  };
  signals: {
    escalationRate: number;
    disagreementRate: number;
  };
  riskScore: number;
  riskGrade: RiskProfileV2["grade"];
}

export function buildUnderwriterFeed(
  tenantId: string,
  profile: RiskProfileV2,
  assurance: WilsonInterval,
  generatedAt: string,
): UnderwriterFeed {
  return {
    feedVersion: UNDERWRITER_FEED_VERSION,
    tenantId,
    generatedAt,
    posture: {
      autonomyRate: round(profile.autonomyRate),
      irreversibleMix: round(profile.irreversibleMix),
      policyFailureRate: round(profile.policyFailureRate),
      oversightCoverage: round(profile.oversightCoverage),
      maxBlastRadius: profile.maxBlastRadius,
    },
    assurance: {
      verifiedAccuracyLowerBound: round(assurance.lower),
      sampleSize: assurance.n,
      confidence: assurance.confidence,
    },
    signals: {
      escalationRate: round(profile.escalationRate),
      disagreementRate: round(profile.disagreementRate),
    },
    riskScore: profile.compositeRisk,
    riskGrade: profile.grade,
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
