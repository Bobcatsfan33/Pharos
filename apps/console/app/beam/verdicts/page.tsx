import { api } from "../../lib/api";
import { requireSession } from "../../lib/session";

interface ActionRecord {
  content: {
    sequence: number;
    action: { type: string; agentId: string };
    verdict: {
      decision: string;
      tierReached: number | string;
      riskScore: number;
      ruleCitations: { ruleId: string }[];
      judgeVersion: string | null;
      latency: { totalMs: number; deadlineMs: number; deadlineBreached: boolean };
      failMode: string | null;
    };
  };
  seal: { contentHash: string };
}

const DECISION_TONE: Record<string, string> = {
  allow: "tone-ok",
  block: "tone-bad",
  escalate: "tone-warn",
  modify: "tone-info",
};

export default async function VerdictsPage() {
  // Auth gate + per-user tenant scoping (#79): verified BEFORE any evidence is fetched.
  const { principal, token } = await requireSession();
  const tenantId = principal.tenantId;
  const chain = await api<{ count: number }>(`/v1/chain/${tenantId}`, token);
  const count = chain?.count ?? 0;
  const records: ActionRecord[] = [];
  for (let seq = Math.max(0, count - 25); seq < count; seq++) {
    const r = await api<ActionRecord>(`/v1/records/${tenantId}/${seq}`, token);
    if (r) records.push(r);
  }
  records.reverse();

  return (
    <div>
      <h1 className="fs-24">Verdicts</h1>
      <p className="c-muted">
        Every verdict shows the tier reached, decision, risk score, and rule citations — written for
        an examiner.
      </p>
      {records.length === 0 ? (
        <Empty />
      ) : (
        <table className="w-100 border-collapse-collapse mt-16 fs-14">
          <thead>
            <tr className="text-align-left c-dim border-bottom-1px-solid-1f2937">
              <th className="p-8">Seq</th>
              <th className="p-8">Action</th>
              <th className="p-8">Agent</th>
              <th className="p-8">Decision</th>
              <th className="p-8">Tier</th>
              <th className="p-8">Risk</th>
              <th className="p-8">Judge</th>
              <th className="p-8">Budget</th>
              <th className="p-8">Citations</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.content.sequence} className="border-bottom-1px-solid-111827">
                <td className="p-8 c-dim">{r.content.sequence}</td>
                <td className="p-8">{r.content.action.type}</td>
                <td className="p-8 c-muted">{r.content.action.agentId}</td>
                <td
                  className={`p-8 fw-600 ${DECISION_TONE[r.content.verdict.decision] ?? "tone-neutral"}`}
                >
                  {r.content.verdict.decision}
                </td>
                <td className="p-8">{r.content.verdict.tierReached}</td>
                <td className="p-8">{r.content.verdict.riskScore.toFixed(2)}</td>
                <td className="p-8 c-muted font-family-ui-monospace-monospace fs-11">
                  {r.content.verdict.judgeVersion ?? "—"}
                </td>
                <td
                  className={`p-8 ${r.content.verdict.latency.deadlineBreached ? "tone-bad" : "tone-muted"}`}
                >
                  {r.content.verdict.latency.totalMs.toFixed(2)}/
                  {r.content.verdict.latency.deadlineMs}ms
                  {r.content.verdict.failMode ? ` · ${r.content.verdict.failMode}` : ""}
                </td>
                <td className="p-8 c-muted">
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
    <p className="c-dim mt-24">
      No verdicts yet. Start the API and run <code>pnpm demo:durability</code> to seal some demo
      records.
    </p>
  );
}
