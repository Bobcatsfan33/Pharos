import { api, DEMO_TENANT } from "../../lib/api";

interface ChainVerification {
  ok: boolean;
  tenantId: string | null;
  recordsChecked: number;
  firstBrokenSequence: number | null;
  errors: string[];
}

export default async function ChainPage() {
  const report = await api<ChainVerification>(`/v1/chain/${DEMO_TENANT}/verify`);
  return (
    <div>
      <h1 style={{ fontSize: 24 }}>Chain integrity</h1>
      <p style={{ color: "#9ca3af", maxWidth: 640 }}>
        Continuous genesis-to-head verification of the evidence hash chain. A break alerts immediately. Any
        third party can reproduce this offline using only the exported records and the published public keyset.
      </p>
      {report === null ? (
        <p style={{ color: "#6b7280", marginTop: 24 }}>API unreachable, or no records for {DEMO_TENANT} yet.</p>
      ) : (
        <div
          style={{
            marginTop: 20,
            border: `1px solid ${report.ok ? "#065f46" : "#7f1d1d"}`,
            background: report.ok ? "#04231b" : "#2a0e0e",
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, color: report.ok ? "#34d399" : "#f87171" }}>
            {report.ok ? "✅ Chain verified" : "❌ Chain broken"}
          </div>
          <div style={{ color: "#9ca3af", marginTop: 8, fontSize: 14 }}>
            Tenant <code>{report.tenantId}</code> · {report.recordsChecked} records checked
            {report.firstBrokenSequence !== null && <> · first break at sequence {report.firstBrokenSequence}</>}
          </div>
          {report.errors.length > 0 && (
            <ul style={{ color: "#fca5a5", fontSize: 13, marginTop: 8 }}>
              {report.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
