import { api } from "../../lib/api";
import { requireSession } from "../../lib/session";

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

const STATUS_TONE: Record<string, string> = {
  draft: "tone-muted",
  sealed: "tone-info",
  released: "tone-ok",
};

export default async function ClaimsPacksPage() {
  // Auth gate + per-user tenant scoping (#79): verified BEFORE any evidence is fetched.
  const { principal, token } = await requireSession();
  const tenantId = principal.tenantId;
  const data = await api<{ packs: Pack[] }>(`/v1/tenants/${tenantId}/claims-packs`, token);
  const packs = data?.packs ?? [];
  return (
    <div>
      <h1 className="fs-24">Claims packs</h1>
      <p className="c-muted maxw-680">
        Audience-scoped, offline-verifiable evidence bundles assembled from an incident: scoped
        record sets, custody attestation, trusted-time anchors, and field-level redaction — all
        verifiable by a third party without trusting Pharos.
      </p>
      {packs.length === 0 ? (
        <p className="c-dim mt-24">No claims packs yet.</p>
      ) : (
        <table className="w-100 border-collapse-collapse mt-16 fs-14">
          <thead>
            <tr className="text-align-left c-dim border-bottom-1px-solid-1f2937">
              <th className="p-8">Incident</th>
              <th className="p-8">Audience</th>
              <th className="p-8">Range</th>
              <th className="p-8">Redacted</th>
              <th className="p-8">Status</th>
              <th className="p-8">Released to</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((p) => (
              <tr key={p.id} className="border-bottom-1px-solid-111827">
                <td className="p-8">{p.incident ?? "—"}</td>
                <td className="p-8 c-muted">{p.audience}</td>
                <td className="p-8">
                  {p.fromSequence}–{p.toSequence}
                </td>
                <td className="p-8 c-muted">{p.redactFields.join(", ") || "—"}</td>
                <td className={`p-8 fw-600 ${STATUS_TONE[p.status] ?? "tone-neutral"}`}>
                  {p.status}
                </td>
                <td className="p-8 c-dim">{p.releasedTo ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
