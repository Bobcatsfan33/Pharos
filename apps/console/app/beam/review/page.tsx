import { api } from "../../lib/api";
import { requireSession } from "../../lib/session";

interface Analytics {
  resolved: number;
  medianReviewTimeMs: number;
  slaAttainment: number;
  disagreementRate: number;
  byReviewer: Record<string, number>;
  byQueue: Record<string, number>;
  queueDepth: Record<string, number>;
}

interface RuleCandidate {
  ruleId: string;
  pack: string | null;
  disagreements: number;
  direction: string;
  rationale: string;
}

export default async function ReviewOpsPage() {
  // Auth gate + per-user tenant scoping (#79): verified BEFORE any evidence is fetched.
  const { principal, token } = await requireSession();
  const tenantId = principal.tenantId;
  const analytics = await api<Analytics>(`/v1/tenants/${tenantId}/review/analytics`, token);
  const disagreements = await api<{ ruleCandidates: RuleCandidate[] }>(
    `/v1/tenants/${tenantId}/review/disagreements`,
    token,
  );

  return (
    <div>
      <h1 className="fs-24">Review operations</h1>
      <p className="c-muted maxw-680">
        The human tier as an operating system: routed queues with SLAs, reviewer analytics, and a
        machine-vs-human disagreement loop that drafts policy rule candidates.
      </p>

      {!analytics ? (
        <p className="c-dim mt-24">
          API unreachable or no review traffic yet (a read-scoped{" "}
          <code>PHAROS_CONSOLE_API_KEY</code> is required).
        </p>
      ) : (
        <>
          <div className="display-flex gap-12 mt-20 flex-wrap-wrap">
            <Stat label="Resolved" value={String(analytics.resolved)} />
            <Stat
              label="Median review time"
              value={`${(analytics.medianReviewTimeMs / 1000).toFixed(1)}s`}
            />
            <Stat
              label="SLA attainment"
              value={`${(analytics.slaAttainment * 100).toFixed(1)}%`}
              good={analytics.slaAttainment >= 0.95}
            />
            <Stat
              label="Disagreement rate"
              value={`${(analytics.disagreementRate * 100).toFixed(1)}%`}
            />
          </div>

          <h2 className="fs-16 mt-28">Queue depth (pending)</h2>
          <div className="display-flex gap-12 mt-8 flex-wrap-wrap">
            {Object.entries(analytics.queueDepth ?? {}).map(([q, n]) => (
              <Stat key={q} label={q} value={String(n)} />
            ))}
            {Object.keys(analytics.queueDepth ?? {}).length === 0 && (
              <span className="c-dim">queues empty</span>
            )}
          </div>

          <h2 className="fs-16 mt-28">Draft rule candidates (feedback loop)</h2>
          {disagreements && disagreements.ruleCandidates.length > 0 ? (
            <div className="mt-8 display-flex flex-direction-column gap-8">
              {disagreements.ruleCandidates.map((c) => (
                <div key={c.ruleId} className="border-1px-solid-1f2937 radius-10 p-14 fs-14">
                  <strong>{c.ruleId}</strong>{" "}
                  <span className={c.direction === "loosen" ? "tone-warn" : "tone-info"}>
                    [{c.direction}]
                  </span>{" "}
                  <span className="c-dim">· {c.disagreements} disagreements</span>
                  <div className="c-muted mt-4">{c.rationale}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="c-dim mt-8">No disagreement clusters yet.</p>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="border-1px-solid-1f2937 radius-10 p-12px-16px minw-120">
      <div className="fs-11 c-dim text-transform-uppercase ls-1">{label}</div>
      <div
        className={`fs-22 fw-700 ${good === undefined ? "tone-neutral" : good ? "tone-ok" : "tone-bad"}`}
      >
        {value}
      </div>
    </div>
  );
}
