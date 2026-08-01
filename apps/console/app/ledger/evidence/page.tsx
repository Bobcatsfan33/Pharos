import { api } from "../../lib/api";
import { requireSession } from "../../lib/session";

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
      <h1 className="fs-24">Evidence explorer</h1>
      <p className="c-muted">
        Each sealed ActionRecord binds the action to its mandate, oversight state, blast radius,
        verdict, and the key that signed it — chained to its predecessor.
      </p>
      {records.length === 0 ? (
        <p className="c-dim mt-24">No evidence yet.</p>
      ) : (
        <div className="mt-16 display-flex flex-direction-column gap-10">
          {records.map((r) => (
            <div key={r.content.id} className="border-1px-solid-1f2937 radius-10 p-14 fs-13">
              <div className="display-flex justify-content-space-between">
                <strong>
                  #{r.content.sequence} · {r.content.action.type}
                </strong>
                <span className="c-dim">{r.content.sealedAt}</span>
              </div>
              <div className="c-muted mt-6">
                verdict <b>{r.content.verdict.decision}</b> · oversight{" "}
                {r.content.liability.oversightMode} · blast{" "}
                {r.content.liability.blastRadius.financialAmount}{" "}
                {r.content.liability.blastRadius.currency} (
                {r.content.liability.blastRadius.reversibility}) · mandate{" "}
                {r.content.liability.mandate?.id ?? "none"}
              </div>
              <div className="c-faint mt-6 font-family-ui-monospace-monospace fs-11">
                hash {r.seal.contentHash.slice(0, 24)}… ← prev {r.seal.prevHash.slice(0, 16)}… · key{" "}
                {r.seal.keyId}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
