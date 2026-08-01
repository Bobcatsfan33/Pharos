import { api } from "../../lib/api";
import { requireSession } from "../../lib/session";

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

const STATUS_TONE: Record<string, string> = {
  draft: "tone-muted",
  shadow: "tone-warn",
  active: "tone-ok",
  rolled_back: "tone-bad",
  archived: "tone-dim",
};

export default async function PoliciesPage() {
  // Auth gate + per-user tenant scoping (#79): verified BEFORE any evidence is fetched.
  const { principal, token } = await requireSession();
  const tenantId = principal.tenantId;
  const data = await api<{ policies: PolicyVersion[]; shippedPacks: ShippedPack[] }>(
    `/v1/tenants/${tenantId}/policies`,
    token,
  );
  const shipped = data?.shippedPacks ?? [
    { packId: "finra", version: "2.0.0", rules: 4 },
    { packId: "hipaa", version: "2.0.0", rules: 3 },
  ];
  const policies = data?.policies ?? [];

  return (
    <div>
      <h1 className="fs-24">Policy packs</h1>
      <p className="c-muted maxw-680">
        Citation-level regulation packs power the verdict cascade; tenant policies compile from
        natural language and move through a draft → shadow → active → rollback lifecycle.
      </p>

      <h2 className="fs-16 mt-24">Shipped regulation packs</h2>
      <div className="display-flex gap-12 mt-8 flex-wrap-wrap">
        {shipped.map((p) => (
          <div key={p.packId} className="border-1px-solid-1f2937 radius-12 p-16 minw-180">
            <div className="fw-600 text-transform-uppercase">{p.packId}</div>
            <div className="c-muted fs-13 mt-4">
              v{p.version} · {p.rules} citation-level rules
            </div>
          </div>
        ))}
      </div>

      <h2 className="fs-16 mt-28">Tenant policies</h2>
      {policies.length === 0 ? (
        <p className="c-dim mt-8">
          No compiled policies yet. Compile one via{" "}
          <code>POST /v1/tenants/&lt;t&gt;/policies/compile</code>.
        </p>
      ) : (
        <table className="w-100 border-collapse-collapse mt-8 fs-14">
          <thead>
            <tr className="text-align-left c-dim border-bottom-1px-solid-1f2937">
              <th className="p-8">Name</th>
              <th className="p-8">Version</th>
              <th className="p-8">Status</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.id} className="border-bottom-1px-solid-111827">
                <td className="p-8">{p.name}</td>
                <td className="p-8 c-muted">v{p.version}</td>
                <td className={`p-8 fw-600 ${STATUS_TONE[p.status] ?? "tone-neutral"}`}>
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
