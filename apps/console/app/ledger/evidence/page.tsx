import { api, DEMO_TENANT } from "../../lib/api";

interface ActionRecord {
  content: {
    id: string;
    sequence: number;
    sealedAt: string;
    action: { type: string; agentId: string };
    verdict: { decision: string };
    liability: {
      oversightMode: string;
      blastRadius: { financialAmount: number; currency: string; reversibility: string };
      mandate: { id: string } | null;
    };
  };
  seal: { contentHash: string; prevHash: string; keyId: string };
}

export default async function EvidencePage() {
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
      <h1 style={{ fontSize: 24 }}>Evidence explorer</h1>
      <p style={{ color: "#9ca3af" }}>
        Each sealed ActionRecord binds the action to its mandate, oversight state, blast radius, verdict, and
        the key that signed it — chained to its predecessor.
      </p>
      {records.length === 0 ? (
        <p style={{ color: "#6b7280", marginTop: 24 }}>No evidence yet.</p>
      ) : (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {records.map((r) => (
            <div key={r.content.id} style={{ border: "1px solid #1f2937", borderRadius: 10, padding: 14, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>
                  #{r.content.sequence} · {r.content.action.type}
                </strong>
                <span style={{ color: "#6b7280" }}>{r.content.sealedAt}</span>
              </div>
              <div style={{ color: "#9ca3af", marginTop: 6 }}>
                verdict <b>{r.content.verdict.decision}</b> · oversight {r.content.liability.oversightMode} · blast{" "}
                {r.content.liability.blastRadius.financialAmount} {r.content.liability.blastRadius.currency} (
                {r.content.liability.blastRadius.reversibility}) · mandate {r.content.liability.mandate?.id ?? "none"}
              </div>
              <div style={{ color: "#4b5563", marginTop: 6, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                hash {r.seal.contentHash.slice(0, 24)}… ← prev {r.seal.prevHash.slice(0, 16)}… · key {r.seal.keyId}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
