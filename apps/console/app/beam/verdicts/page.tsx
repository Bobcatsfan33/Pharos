import { api, DEMO_TENANT } from "../../lib/api";

interface ActionRecord {
  content: {
    sequence: number;
    action: { type: string; agentId: string };
    verdict: { decision: string; tierReached: number | string; riskScore: number; ruleCitations: { ruleId: string }[] };
  };
  seal: { contentHash: string };
}

const COLORS: Record<string, string> = {
  allow: "#34d399",
  block: "#f87171",
  escalate: "#fbbf24",
  modify: "#60a5fa",
};

export default async function VerdictsPage() {
  const chain = await api<{ count: number }>(`/v1/chain/${DEMO_TENANT}`);
  const count = chain?.count ?? 0;
  const records: ActionRecord[] = [];
  for (let seq = Math.max(0, count - 25); seq < count; seq++) {
    const r = await api<ActionRecord>(`/v1/records/${DEMO_TENANT}/${seq}`);
    if (r) records.push(r);
  }
  records.reverse();

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>Verdicts</h1>
      <p style={{ color: "#9ca3af" }}>Every verdict shows the tier reached, decision, risk score, and rule citations — written for an examiner.</p>
      {records.length === 0 ? (
        <Empty />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16, fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #1f2937" }}>
              <th style={{ padding: 8 }}>Seq</th>
              <th style={{ padding: 8 }}>Action</th>
              <th style={{ padding: 8 }}>Agent</th>
              <th style={{ padding: 8 }}>Decision</th>
              <th style={{ padding: 8 }}>Tier</th>
              <th style={{ padding: 8 }}>Risk</th>
              <th style={{ padding: 8 }}>Citations</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.content.sequence} style={{ borderBottom: "1px solid #111827" }}>
                <td style={{ padding: 8, color: "#6b7280" }}>{r.content.sequence}</td>
                <td style={{ padding: 8 }}>{r.content.action.type}</td>
                <td style={{ padding: 8, color: "#9ca3af" }}>{r.content.action.agentId}</td>
                <td style={{ padding: 8, color: COLORS[r.content.verdict.decision] ?? "#e5e7eb", fontWeight: 600 }}>
                  {r.content.verdict.decision}
                </td>
                <td style={{ padding: 8 }}>{r.content.verdict.tierReached}</td>
                <td style={{ padding: 8 }}>{r.content.verdict.riskScore.toFixed(2)}</td>
                <td style={{ padding: 8, color: "#9ca3af" }}>
                  {r.content.verdict.ruleCitations.map((c) => c.ruleId).join(", ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Empty() {
  return (
    <p style={{ color: "#6b7280", marginTop: 24 }}>
      No verdicts yet. Start the API and run <code>pnpm demo:durability</code> to seal some demo records.
    </p>
  );
}
