import { api, DEMO_TENANT } from "../../lib/api";

interface Pack {
  id: string;
  incident: string | null;
  audience: string;
  fromSequence: number;
  toSequence: number;
  redactFields: string[];
  status: string;
  releasedTo: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  draft: "#9ca3af",
  sealed: "#60a5fa",
  released: "#34d399",
};

export default async function ClaimsPacksPage() {
  const data = await api<{ packs: Pack[] }>(`/v1/tenants/${DEMO_TENANT}/claims-packs`);
  const packs = data?.packs ?? [];
  return (
    <div>
      <h1 style={{ fontSize: 24 }}>Claims packs</h1>
      <p style={{ color: "#9ca3af", maxWidth: 680 }}>
        Audience-scoped, offline-verifiable evidence bundles assembled from an incident: scoped
        record sets, custody attestation, trusted-time anchors, and field-level redaction — all
        verifiable by a third party without trusting Pharos.
      </p>
      {packs.length === 0 ? (
        <p style={{ color: "#6b7280", marginTop: 24 }}>No claims packs yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16, fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #1f2937" }}>
              <th style={{ padding: 8 }}>Incident</th>
              <th style={{ padding: 8 }}>Audience</th>
              <th style={{ padding: 8 }}>Range</th>
              <th style={{ padding: 8 }}>Redacted</th>
              <th style={{ padding: 8 }}>Status</th>
              <th style={{ padding: 8 }}>Released to</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid #111827" }}>
                <td style={{ padding: 8 }}>{p.incident ?? "—"}</td>
                <td style={{ padding: 8, color: "#9ca3af" }}>{p.audience}</td>
                <td style={{ padding: 8 }}>
                  {p.fromSequence}–{p.toSequence}
                </td>
                <td style={{ padding: 8, color: "#9ca3af" }}>{p.redactFields.join(", ") || "—"}</td>
                <td
                  style={{
                    padding: 8,
                    color: STATUS_COLOR[p.status] ?? "#e5e7eb",
                    fontWeight: 600,
                  }}
                >
                  {p.status}
                </td>
                <td style={{ padding: 8, color: "#6b7280" }}>{p.releasedTo ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
