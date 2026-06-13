import { type VerdictContext, sha256Hex } from "@pharos/core";

/**
 * Reproducibility harness.
 *
 * A verdict is reproducible if, given the same policy, judge versions, and inputs, the
 * cascade produces the same decision. Latency is wall-clock and excluded; everything else
 * — decision, tier, citations, risk, fail-mode, judge version — is hashed into a stable
 * fingerprint. Two verdicts are bit-identical iff their fingerprints match.
 */
export function fingerprintVerdict(v: VerdictContext): string {
  return sha256Hex({
    decision: v.decision,
    tierReached: v.tierReached,
    ruleCitations: v.ruleCitations,
    riskScore: v.riskScore,
    failMode: v.failMode,
    judgeVersion: v.judgeVersion,
  });
}

export function verdictsIdentical(a: VerdictContext, b: VerdictContext): boolean {
  return fingerprintVerdict(a) === fingerprintVerdict(b);
}
