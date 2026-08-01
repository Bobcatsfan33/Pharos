import { api } from "../../lib/api";
import { requireSession } from "../../lib/session";

interface AuditEntry {
  sequence: number;
  actor: string;
  actorKind: string;
  action: string;
  resource: string;
  at: string;
  entryHash: string;
}

export default async function AccessAuditPage() {
  // Auth gate + per-user tenant scoping (#79): verified BEFORE any evidence is fetched.
  const { principal, token } = await requireSession();
  const tenantId = principal.tenantId;
  const data = await api<{ entries: AuditEntry[] }>(`/v1/tenants/${tenantId}/audit`, token);
  const verify = await api<{ ok: boolean; entriesChecked: number }>(
    `/v1/tenants/${tenantId}/audit/verify`,
    token,
  );
  const entries = (data?.entries ?? []).slice().reverse();

  return (
    <div>
      <h1 className="fs-24">Access audit</h1>
      <p className="c-muted maxw-640">
        An evidence product whose own access is itself evidence. Every view, export, share, and
        verification of evidence is recorded as a hash-chained, tamper-evident entry.
      </p>
      {verify && (
        <div className={`mt-12 fs-14 ${verify.ok ? "tone-ok" : "tone-bad"}`}>
          {verify.ok ? "✅" : "❌"} Audit chain {verify.ok ? "verified" : "broken"} ·{" "}
          {verify.entriesChecked} entries
        </div>
      )}
      {entries.length === 0 ? (
        <p className="c-dim mt-24">
          No access recorded yet (or a read-scoped <code>PHAROS_CONSOLE_API_KEY</code> is not
          configured).
        </p>
      ) : (
        <table className="w-100 border-collapse-collapse mt-16 fs-13">
          <thead>
            <tr className="text-align-left c-dim border-bottom-1px-solid-1f2937">
              <th className="p-8">#</th>
              <th className="p-8">Actor</th>
              <th className="p-8">Action</th>
              <th className="p-8">Resource</th>
              <th className="p-8">When</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.sequence} className="border-bottom-1px-solid-111827">
                <td className="p-8 c-dim">{e.sequence}</td>
                <td className="p-8">
                  {e.actor} <span className="c-dim">({e.actorKind})</span>
                </td>
                <td className="p-8">{e.action}</td>
                <td className="p-8 c-muted">{e.resource}</td>
                <td className="p-8 c-dim">{e.at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
