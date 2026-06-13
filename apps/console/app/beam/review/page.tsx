import { api, DEMO_TENANT } from "../../lib/api";

interface Analytics {
  resolved: number;
  medianReviewTimeMs: number;
  slaAttainment: number;
  disagreementRate: number;
  byReviewer: Record<string, number>;
  byQueue: Record<string, number>;
  queueDepth: Record<string, number>;
}

interface RuleCandidate {
  ruleId: string;
  pack: string | null;
  disagreements: number;
  direction: string;
  rationale: string;
}

export default async function ReviewOpsPage() {
  const analytics = await api<Analytics>(`/v1/tenants/${DEMO_TENANT}/review/analytics`);
  const disagreements = await api<{ ruleCandidates: RuleCandidate[] }>(`/v1/tenants/${DEMO_TENANT}/review/disagreements`);

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>Review operations</h1>
      <p style={{ color: "#9ca3af", maxWidth: 680 }}>
        The human tier as an operating system: routed queues with SLAs, reviewer analytics, and a
        machine-vs-human disagreement loop that drafts policy rule candidates.
      </p>

      {!analytics ? (
        <p style={{ color: "#6b7280", marginTop: 24 }}>
          API unreachable or no review traffic yet (a read-scoped <code>PHAROS_CONSOLE_API_KEY</code> is required).
        </p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
            <Stat label="Resolved" value={String(analytics.resolved)} />
            <Stat label="Median review time" value={`${(analytics.medianReviewTimeMs / 1000).toFixed(1)}s`} />
            <Stat label="SLA attainment" value={`${(analytics.slaAttainment * 100).toFixed(1)}%`} good={analytics.slaAttainment >= 0.95} />
            <Stat label="Disagreement rate" value={`${(analytics.disagreementRate * 100).toFixed(1)}%`} />
          </div>

          <h2 style={{ fontSize: 16, marginTop: 28 }}>Queue depth (pending)</h2>
          <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
            {Object.entries(analytics.queueDepth ?? {}).map(([q, n]) => (
              <Stat key={q} label={q} value={String(n)} />
            ))}
            {Object.keys(analytics.queueDepth ?? {}).length === 0 && <span style={{ color: "#6b7280" }}>queues empty</span>}
          </div>

          <h2 style={{ fontSize: 16, marginTop: 28 }}>Draft rule candidates (feedback loop)</h2>
          {disagreements && disagreements.ruleCandidates.length > 0 ? (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              {disagreements.ruleCandidates.map((c) => (
                <div key={c.ruleId} style={{ border: "1px solid #1f2937", borderRadius: 10, padding: 14, fontSize: 14 }}>
                  <strong>{c.ruleId}</strong>{" "}
                  <span style={{ color: c.direction === "loosen" ? "#fbbf24" : "#60a5fa" }}>[{c.direction}]</span>{" "}
                  <span style={{ color: "#6b7280" }}>· {c.disagreements} disagreements</span>
                  <div style={{ color: "#9ca3af", marginTop: 4 }}>{c.rationale}</div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: "#6b7280", marginTop: 8 }}>No disagreement clusters yet.</p>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div style={{ border: "1px solid #1f2937", borderRadius: 10, padding: "12px 16px", minWidth: 120 }}>
      <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: good === undefined ? "#e5e7eb" : good ? "#34d399" : "#f87171" }}>{value}</div>
    </div>
  );
}
