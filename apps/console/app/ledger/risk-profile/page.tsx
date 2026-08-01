import { api } from "../../lib/api";
import { requireSession } from "../../lib/session";

interface RiskProfile {
  records: number;
  autonomyRate: number;
  irreversibleMix: number;
  policyFailureRate: number;
  oversightCoverage: number;
  escalationRate: number;
  disagreementRate: number;
  assuranceLowerBound: number;
  compositeRisk: number;
  grade: string;
}
interface Assurance {
  verifiedAccuracy: { lower: number; point: number; upper: number; n: number; confidence: number };
  samples: number;
}
interface Readiness {
  blocked: boolean;
  checks: Array<{
    id: string;
    description: string;
    value: number;
    threshold: number;
    passed: boolean;
    excepted: boolean;
  }>;
}

const GRADE_TONE: Record<string, { ring: string; text: string }> = {
  A: { ring: "grade-ring-a", text: "tone-ok" },
  B: { ring: "grade-ring-b", text: "tone-info" },
  C: { ring: "grade-ring-c", text: "tone-warn" },
  D: { ring: "grade-ring-d", text: "tone-bad" },
};

export default async function RiskProfilePage() {
  // Auth gate + per-user tenant scoping (#79): verified BEFORE any evidence is fetched.
  const { principal, token } = await requireSession();
  const tenantId = principal.tenantId;
  const profile = await api<{ riskProfile: RiskProfile }>(
    `/v1/tenants/${tenantId}/risk-profile`,
    token,
  );
  const assurance = await api<Assurance>(`/v1/tenants/${tenantId}/assurance`, token);
  const readiness = await api<{ readiness: Readiness }>(`/v1/tenants/${tenantId}/readiness`, token);
  const p = profile?.riskProfile;

  return (
    <div>
      <h1 className="fs-24">Risk profile</h1>
      <p className="c-muted maxw-680">
        Continuous posture from sealed records plus Beam signals, the measured Wilson-score
        verified-accuracy bound, and the external-release readiness gate. This is the
        underwriter-feed signal.
      </p>

      {assurance && (
        <div className="mt-16 border-1px-solid-1f2937 radius-12 p-16">
          <div className="fs-12 c-dim text-transform-uppercase ls-1">
            Verified accuracy (Wilson 95%)
          </div>
          <div className="fs-26 fw-700 c-ok">
            ≥ {(assurance.verifiedAccuracy.lower * 100).toFixed(1)}%
          </div>
          <div className="c-muted fs-13">
            point {(assurance.verifiedAccuracy.point * 100).toFixed(1)}% · n=
            {assurance.verifiedAccuracy.n} · measured, not modeled
          </div>
        </div>
      )}

      {p && (
        <>
          <div className="display-flex gap-12 mt-16 align-items-center flex-wrap-wrap">
            <div className={`radius-12 p-12px-20px ${GRADE_TONE[p.grade]?.ring ?? ""}`}>
              <div className="fs-11 c-dim">GRADE</div>
              <div className={`fs-32 fw-800 ${GRADE_TONE[p.grade]?.text ?? ""}`}>{p.grade}</div>
            </div>
            <Stat label="Composite risk" value={`${p.compositeRisk}/100`} />
            <Stat label="Autonomy rate" value={pct(p.autonomyRate)} />
            <Stat label="Irreversible mix" value={pct(p.irreversibleMix)} />
            <Stat label="Oversight coverage" value={pct(p.oversightCoverage)} />
            <Stat label="Escalation rate" value={pct(p.escalationRate)} />
            <Stat label="Disagreement" value={pct(p.disagreementRate)} />
          </div>
        </>
      )}

      <h2 className="fs-16 mt-28">Readiness gate</h2>
      {readiness ? (
        <div className="mt-8">
          <div className={`fw-600 ${readiness.readiness.blocked ? "tone-bad" : "tone-ok"}`}>
            {readiness.readiness.blocked
              ? "❌ External release blocked"
              : "✅ Ready for external release"}
          </div>
          <ul className="mt-8 fs-14 c-muted">
            {readiness.readiness.checks.map((c) => (
              <li key={c.id} className={c.passed ? "tone-muted" : "tone-bad"}>
                {c.passed ? "✓" : "✗"} {c.description} ({(c.value * 100).toFixed(0)}%
                {c.excepted ? ", exception granted" : ""})
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="c-dim">No data.</p>
      )}
    </div>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-1px-solid-1f2937 radius-10 p-10px-14px minw-110">
      <div className="fs-11 c-dim text-transform-uppercase ls-1">{label}</div>
      <div className="fs-18 fw-700">{value}</div>
    </div>
  );
}
