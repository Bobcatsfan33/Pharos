import { api, DEMO_TENANT } from "../../lib/api";

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

const GRADE_COLOR: Record<string, string> = {
  A: "#34d399",
  B: "#60a5fa",
  C: "#fbbf24",
  D: "#f87171",
};

export default async function RiskProfilePage() {
  const profile = await api<{ riskProfile: RiskProfile }>(
    `/v1/tenants/${DEMO_TENANT}/risk-profile`,
  );
  const assurance = await api<Assurance>(`/v1/tenants/${DEMO_TENANT}/assurance`);
  const readiness = await api<{ readiness: Readiness }>(`/v1/tenants/${DEMO_TENANT}/readiness`);
  const p = profile?.riskProfile;

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>Risk profile</h1>
      <p style={{ color: "#9ca3af", maxWidth: 680 }}>
        Continuous posture from sealed records plus Beam signals, the measured Wilson-score
        verified-accuracy bound, and the external-release readiness gate. This is the
        underwriter-feed signal.
      </p>

      {assurance && (
        <div style={{ marginTop: 16, border: "1px solid #1f2937", borderRadius: 12, padding: 16 }}>
          <div
            style={{ fontSize: 12, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}
          >
            Verified accuracy (Wilson 95%)
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#34d399" }}>
            ≥ {(assurance.verifiedAccuracy.lower * 100).toFixed(1)}%
          </div>
          <div style={{ color: "#9ca3af", fontSize: 13 }}>
            point {(assurance.verifiedAccuracy.point * 100).toFixed(1)}% · n=
            {assurance.verifiedAccuracy.n} · measured, not modeled
          </div>
        </div>
      )}

      {p && (
        <>
          <div
            style={{
              display: "flex",
              gap: 12,
              marginTop: 16,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                border: `2px solid ${GRADE_COLOR[p.grade]}`,
                borderRadius: 12,
                padding: "12px 20px",
              }}
            >
              <div style={{ fontSize: 11, color: "#6b7280" }}>GRADE</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: GRADE_COLOR[p.grade] }}>
                {p.grade}
              </div>
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

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Readiness gate</h2>
      {readiness ? (
        <div style={{ marginTop: 8 }}>
          <div
            style={{ color: readiness.readiness.blocked ? "#f87171" : "#34d399", fontWeight: 600 }}
          >
            {readiness.readiness.blocked
              ? "❌ External release blocked"
              : "✅ Ready for external release"}
          </div>
          <ul style={{ marginTop: 8, fontSize: 14, color: "#9ca3af" }}>
            {readiness.readiness.checks.map((c) => (
              <li key={c.id} style={{ color: c.passed ? "#9ca3af" : "#f87171" }}>
                {c.passed ? "✓" : "✗"} {c.description} ({(c.value * 100).toFixed(0)}%
                {c.excepted ? ", exception granted" : ""})
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p style={{ color: "#6b7280" }}>No data.</p>
      )}
    </div>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{ border: "1px solid #1f2937", borderRadius: 10, padding: "10px 14px", minWidth: 110 }}
    >
      <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
