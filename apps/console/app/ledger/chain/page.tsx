import { api } from "../../lib/api";
import { requireSession } from "../../lib/session";

interface ChainVerification {
  ok: boolean;
  tenantId: string | null;
  recordsChecked: number;
  firstBrokenSequence: number | null;
  errors: string[];
  warnings?: string[];
  anchoring?: {
    headSequence: number | null;
    latestAnchorSequence: number | null;
    latestAnchorTime: string | null;
    headAnchored: boolean;
  };
}

export default async function ChainPage() {
  // Auth gate + per-user tenant scoping (#79): verified BEFORE any evidence is fetched.
  const { principal, token } = await requireSession();
  const tenantId = principal.tenantId;
  const report = await api<ChainVerification>(`/v1/chain/${tenantId}/verify`, token);
  return (
    <div>
      <h1 className="fs-24">Chain integrity</h1>
      <p className="c-muted maxw-640">
        Continuous genesis-to-head verification of the evidence hash chain. A break alerts
        immediately. Any third party can reproduce this offline using only the exported records and
        the published public keyset.
      </p>
      {report === null ? (
        <p className="c-dim mt-24">API unreachable, or no records for {tenantId} yet.</p>
      ) : (
        <div className={`mt-20 radius-12 p-20 ${report.ok ? "panel-ok" : "panel-bad"}`}>
          <div className={`fs-18 fw-700 ${report.ok ? "tone-ok" : "tone-bad"}`}>
            {report.ok ? "✅ Chain verified" : "❌ Chain broken"}
          </div>
          <div className="c-muted mt-8 fs-14">
            Tenant <code>{report.tenantId}</code> · {report.recordsChecked} records checked
            {report.firstBrokenSequence !== null && (
              <> · first break at sequence {report.firstBrokenSequence}</>
            )}
          </div>
          {report.errors.length > 0 && (
            <ul className="c-bad-soft fs-13 mt-8">
              {report.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {report.anchoring && (
            <div className="c-muted mt-10 fs-13">
              Trusted-time anchor:{" "}
              {report.anchoring.latestAnchorSequence === null ? (
                <span className="c-warn">none yet</span>
              ) : (
                <>
                  covers sequence {report.anchoring.latestAnchorSequence}
                  {report.anchoring.latestAnchorTime && (
                    <> · {new Date(report.anchoring.latestAnchorTime).toISOString()}</>
                  )}{" "}
                  ·{" "}
                  {report.anchoring.headAnchored ? (
                    <span className="c-ok">head anchored</span>
                  ) : (
                    <span className="c-warn">head not yet anchored</span>
                  )}
                </>
              )}
            </div>
          )}
          {report.warnings && report.warnings.length > 0 && (
            <ul className="c-warn-soft fs-13 mt-8">
              {report.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
