import { api, DEMO_TENANT } from "../../lib/api";

interface PolicyVersion {
  id: string;
  name: string;
  version: number;
  status: string;
}
interface ShippedPack {
  packId: string;
  version: string;
  rules: number;
}

const STATUS_COLOR: Record<string, string> = {
  draft: "#9ca3af",
  shadow: "#fbbf24",
  active: "#34d399",
  rolled_back: "#f87171",
  archived: "#6b7280",
};

export default async function PoliciesPage() {
  const data = await api<{ policies: PolicyVersion[]; shippedPacks: ShippedPack[] }>(
    `/v1/tenants/${DEMO_TENANT}/policies`,
  );
  const shipped = data?.shippedPacks ?? [
    { packId: "finra", version: "2.0.0", rules: 4 },
    { packId: "hipaa", version: "2.0.0", rules: 3 },
  ];
  const policies = data?.policies ?? [];

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>Policy packs</h1>
      <p style={{ color: "#9ca3af", maxWidth: 680 }}>
        Citation-level regulation packs power the verdict cascade; tenant policies compile from
        natural language and move through a draft → shadow → active → rollback lifecycle.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Shipped regulation packs</h2>
      <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
        {shipped.map((p) => (
          <div
            key={p.packId}
            style={{ border: "1px solid #1f2937", borderRadius: 12, padding: 16, minWidth: 180 }}
          >
            <div style={{ fontWeight: 600, textTransform: "uppercase" }}>{p.packId}</div>
            <div style={{ color: "#9ca3af", fontSize: 13, marginTop: 4 }}>
              v{p.version} · {p.rules} citation-level rules
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Tenant policies</h2>
      {policies.length === 0 ? (
        <p style={{ color: "#6b7280", marginTop: 8 }}>
          No compiled policies yet. Compile one via{" "}
          <code>POST /v1/tenants/&lt;t&gt;/policies/compile</code>.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #1f2937" }}>
              <th style={{ padding: 8 }}>Name</th>
              <th style={{ padding: 8 }}>Version</th>
              <th style={{ padding: 8 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid #111827" }}>
                <td style={{ padding: 8 }}>{p.name}</td>
                <td style={{ padding: 8, color: "#9ca3af" }}>v{p.version}</td>
                <td
                  style={{
                    padding: 8,
                    color: STATUS_COLOR[p.status] ?? "#e5e7eb",
                    fontWeight: 600,
                  }}
                >
                  {p.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
