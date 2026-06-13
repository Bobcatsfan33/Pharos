import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type EscalationStatus = "pending" | "approved" | "modified" | "rejected" | "cancelled";
export type ResolutionDecision = "approve" | "modify" | "reject";

export interface Escalation {
  id: string;
  tenantId: string;
  recordSequence: number;
  status: EscalationStatus;
  context: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
  resolvedBy: string | null;
  idempotencyKey: string;
  createdAt: string;
  resolvedAt: string | null;
  resumedAt: string | null;
  queue: string;
  priority: number;
  slaDueAt: string | null;
  assignedTo: string | null;
  fourEyes: boolean;
}

interface EscalationRow {
  id: string;
  tenant_id: string;
  record_sequence: string;
  status: string;
  context: unknown;
  resolution: unknown;
  resolved_by: string | null;
  idempotency_key: string;
  created_at: string;
  resolved_at: string | null;
  resumed_at: string | null;
  queue: string;
  priority: number;
  sla_due_at: string | null;
  assigned_to: string | null;
  four_eyes: boolean;
}

/**
 * Workflow continuation store.
 *
 * An escalated action parks here with full context. A human verdict (approve/modify/reject)
 * resolves it; the agent's SDK then resumes. claimResume() flips resumed_at atomically so
 * exactly one resumer wins — guaranteeing the pending side effect executes exactly once even
 * under concurrent or retried resumes.
 */
export class EscalationStore {
  constructor(private readonly pool: Pool) {}

  private rowTo(row: EscalationRow): Escalation {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      recordSequence: Number(row.record_sequence),
      status: row.status as EscalationStatus,
      context: parse(row.context) as Record<string, unknown>,
      resolution: row.resolution ? (parse(row.resolution) as Record<string, unknown>) : null,
      resolvedBy: row.resolved_by,
      idempotencyKey: row.idempotency_key,
      createdAt: iso(row.created_at),
      resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
      resumedAt: row.resumed_at ? iso(row.resumed_at) : null,
      queue: row.queue,
      priority: row.priority,
      slaDueAt: row.sla_due_at ? iso(row.sla_due_at) : null,
      assignedTo: row.assigned_to,
      fourEyes: row.four_eyes,
    };
  }

  /** Park an escalation, routed to a queue with a priority + SLA. Idempotent on idempotencyKey. */
  async create(input: {
    tenantId: string;
    recordSequence: number;
    context: Record<string, unknown>;
    idempotencyKey: string;
    queue?: string;
    priority?: number;
    slaDueAt?: string | null;
    fourEyes?: boolean;
  }): Promise<Escalation> {
    const res = await this.pool.query<EscalationRow>(
      `INSERT INTO escalations (id, tenant_id, record_sequence, context, idempotency_key, queue, priority, sla_due_at, four_eyes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET context = escalations.context
       RETURNING *`,
      [
        randomUUID(),
        input.tenantId,
        input.recordSequence,
        JSON.stringify(input.context),
        input.idempotencyKey,
        input.queue ?? "general",
        input.priority ?? 4,
        input.slaDueAt ?? null,
        input.fourEyes ?? false,
      ],
    );
    return this.rowTo(res.rows[0]!);
  }

  async assign(tenantId: string, id: string, reviewer: string): Promise<Escalation | null> {
    const res = await this.pool.query<EscalationRow>(
      `UPDATE escalations SET assigned_to = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING *`,
      [tenantId, id, reviewer],
    );
    return res.rows[0] ? this.rowTo(res.rows[0]) : null;
  }

  async listByQueue(tenantId: string, queue: string): Promise<Escalation[]> {
    const res = await this.pool.query<EscalationRow>(
      `SELECT * FROM escalations WHERE tenant_id = $1 AND queue = $2 AND status = 'pending'
       ORDER BY priority ASC, created_at ASC`,
      [tenantId, queue],
    );
    return res.rows.map((r) => this.rowTo(r));
  }

  async listResolved(tenantId: string, limit = 1000): Promise<Escalation[]> {
    const res = await this.pool.query<EscalationRow>(
      `SELECT * FROM escalations WHERE tenant_id = $1 AND status <> 'pending'
       ORDER BY resolved_at DESC NULLS LAST LIMIT $2`,
      [tenantId, limit],
    );
    return res.rows.map((r) => this.rowTo(r));
  }

  async queueDepths(tenantId: string): Promise<Record<string, number>> {
    const res = await this.pool.query<{ queue: string; n: string }>(
      `SELECT queue, count(*)::text AS n FROM escalations WHERE tenant_id = $1 AND status = 'pending' GROUP BY queue`,
      [tenantId],
    );
    const out: Record<string, number> = {};
    for (const r of res.rows) out[r.queue] = Number(r.n);
    return out;
  }

  /** Pending escalations past their SLA deadline that have not yet been breach-notified. */
  async findNewBreaches(tenantId: string, nowIso: string): Promise<Escalation[]> {
    const res = await this.pool.query<EscalationRow>(
      `UPDATE escalations SET sla_breach_notified = true
       WHERE tenant_id = $1 AND status = 'pending' AND sla_breach_notified = false
         AND sla_due_at IS NOT NULL AND sla_due_at <= $2
       RETURNING *`,
      [tenantId, nowIso],
    );
    return res.rows.map((r) => this.rowTo(r));
  }

  async get(tenantId: string, id: string): Promise<Escalation | null> {
    const res = await this.pool.query<EscalationRow>(
      `SELECT * FROM escalations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return res.rows[0] ? this.rowTo(res.rows[0]) : null;
  }

  async listPending(tenantId: string): Promise<Escalation[]> {
    const res = await this.pool.query<EscalationRow>(
      `SELECT * FROM escalations WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at ASC`,
      [tenantId],
    );
    return res.rows.map((r) => this.rowTo(r));
  }

  /** Resolve a pending escalation with a human verdict. Only acts on pending rows. */
  async resolve(
    tenantId: string,
    id: string,
    input: { decision: ResolutionDecision; rationale: string; resolvedBy: string; modifiedAction?: unknown },
  ): Promise<Escalation | null> {
    const status: EscalationStatus =
      input.decision === "approve" ? "approved" : input.decision === "modify" ? "modified" : "rejected";
    const resolution = {
      decision: input.decision,
      rationale: input.rationale,
      modifiedAction: input.modifiedAction ?? null,
    };
    const res = await this.pool.query<EscalationRow>(
      `UPDATE escalations
         SET status = $3, resolution = $4, resolved_by = $5, resolved_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
       RETURNING *`,
      [tenantId, id, status, JSON.stringify(resolution), input.resolvedBy],
    );
    return res.rows[0] ? this.rowTo(res.rows[0]) : null;
  }

  /**
   * Atomically claim the right to resume. Returns the escalation only to the first caller
   * after an approve/modify resolution; subsequent calls return null. This is the
   * exactly-once gate for the agent's pending side effect.
   */
  async claimResume(tenantId: string, id: string): Promise<Escalation | null> {
    const res = await this.pool.query<EscalationRow>(
      `UPDATE escalations SET resumed_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status IN ('approved','modified') AND resumed_at IS NULL
       RETURNING *`,
      [tenantId, id],
    );
    return res.rows[0] ? this.rowTo(res.rows[0]) : null;
  }
}

function parse(v: unknown): unknown {
  return typeof v === "string" ? JSON.parse(v) : v;
}
function iso(v: string): string {
  return typeof v === "string" && v.includes("T") ? v : new Date(v).toISOString();
}
