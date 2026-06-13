import { api, DEMO_TENANT } from "../../lib/api";

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
  const data = await api<{ entries: AuditEntry[] }>(`/v1/tenants/${DEMO_TENANT}/audit`);
  const verify = await api<{ ok: boolean; entriesChecked: number }>(`/v1/tenants/${DEMO_TENANT}/audit/verify`);
  const entries = (data?.entries ?? []).slice().reverse();

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>Access audit</h1>
      <p style={{ color: "#9ca3af", maxWidth: 640 }}>
        An evidence product whose own access is itself evidence. Every view, export, share, and verification of
        evidence is recorded as a hash-chained, tamper-evident entry.
      </p>
      {verify && (
        <div style={{ marginTop: 12, fontSize: 14, color: verify.ok ? "#34d399" : "#f87171" }}>
          {verify.ok ? "✅" : "❌"} Audit chain {verify.ok ? "verified" : "broken"} · {verify.entriesChecked} entries
        </div>
      )}
      {entries.length === 0 ? (
        <p style={{ color: "#6b7280", marginTop: 24 }}>
          No access recorded yet (or a read-scoped <code>PHAROS_CONSOLE_API_KEY</code> is not configured).
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16, fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #1f2937" }}>
              <th style={{ padding: 8 }}>#</th>
              <th style={{ padding: 8 }}>Actor</th>
              <th style={{ padding: 8 }}>Action</th>
              <th style={{ padding: 8 }}>Resource</th>
              <th style={{ padding: 8 }}>When</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.sequence} style={{ borderBottom: "1px solid #111827" }}>
                <td style={{ padding: 8, color: "#6b7280" }}>{e.sequence}</td>
                <td style={{ padding: 8 }}>
                  {e.actor} <span style={{ color: "#6b7280" }}>({e.actorKind})</span>
                </td>
                <td style={{ padding: 8 }}>{e.action}</td>
                <td style={{ padding: 8, color: "#9ca3af" }}>{e.resource}</td>
                <td style={{ padding: 8, color: "#6b7280" }}>{e.at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
