import { randomUUID } from "node:crypto";
import type { Escalation, EscalationStatus, ResolutionDecision } from "../escalationStore.js";
import type {
  NotificationChannel,
  NotificationEvent,
  NotificationRecord,
  ReviewNotifierOptions,
} from "../notifier.js";
import type { EscalationStorePort, ReviewNotifierPort } from "../ports.js";
import { EmbeddedDb, nowIso, parseJson } from "./sqlite.js";
import { iso, isoOrNull, toBool } from "./governanceStores.js";

interface EscalationRow {
  id: string;
  tenant_id: string;
  record_sequence: number;
  status: string;
  context: unknown;
  resolution: unknown;
  resolved_by: string | null;
  idempotency_key: string;
  created_at: string;
  resolved_at: string | null;
  resumed_at: string | null;
  resume_claim_id: string | null;
  queue: string;
  priority: number;
  sla_due_at: string | null;
  assigned_to: string | null;
  four_eyes: number;
}

/** Embedded workflow continuation store; see `EscalationStore` for the claim semantics. */
export class EmbeddedEscalationStore implements EscalationStorePort {
  constructor(private readonly db: EmbeddedDb) {}

  private rowTo(row: EscalationRow): Escalation {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      recordSequence: Number(row.record_sequence),
      status: row.status as EscalationStatus,
      context: parseJson(row.context) as Record<string, unknown>,
      resolution: row.resolution ? (parseJson(row.resolution) as Record<string, unknown>) : null,
      resolvedBy: row.resolved_by,
      idempotencyKey: row.idempotency_key,
      createdAt: iso(row.created_at),
      resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
      resumedAt: row.resumed_at ? iso(row.resumed_at) : null,
      resumeClaimId: row.resume_claim_id,
      queue: row.queue,
      priority: Number(row.priority),
      slaDueAt: row.sla_due_at ? iso(row.sla_due_at) : null,
      assignedTo: row.assigned_to,
      fourEyes: toBool(row.four_eyes),
    };
  }

  /** Park an escalation, routed to a queue with a priority + SLA. Idempotent on idempotencyKey. */
  create(input: {
    tenantId: string;
    recordSequence: number;
    context: Record<string, unknown>;
    idempotencyKey: string;
    queue?: string;
    priority?: number;
    slaDueAt?: string | null;
    fourEyes?: boolean;
  }): Promise<Escalation> {
    return this.db.transaction(() => {
      this.db.run(
        `INSERT OR IGNORE INTO escalations
           (id, tenant_id, record_sequence, context, idempotency_key, queue, priority, sla_due_at, four_eyes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        input.tenantId,
        input.recordSequence,
        JSON.stringify(input.context),
        input.idempotencyKey,
        input.queue ?? "general",
        input.priority ?? 4,
        isoOrNull(input.slaDueAt),
        (input.fourEyes ?? false) ? 1 : 0,
        nowIso(),
      );
      const row = this.db.get<EscalationRow>(
        `SELECT * FROM escalations WHERE tenant_id = ? AND idempotency_key = ?`,
        input.tenantId,
        input.idempotencyKey,
      );
      return this.rowTo(row!);
    });
  }

  assign(tenantId: string, id: string, reviewer: string): Promise<Escalation | null> {
    return this.db.exclusive(() => {
      const row = this.db.get<EscalationRow>(
        `UPDATE escalations SET assigned_to = ? WHERE tenant_id = ? AND id = ? AND status = 'pending' RETURNING *`,
        reviewer,
        tenantId,
        id,
      );
      return row ? this.rowTo(row) : null;
    });
  }

  listByQueue(tenantId: string, queue: string): Promise<Escalation[]> {
    return this.db.exclusive(() =>
      this.db
        .all<EscalationRow>(
          `SELECT * FROM escalations WHERE tenant_id = ? AND queue = ? AND status = 'pending'
           ORDER BY priority ASC, created_at ASC, rowid ASC`,
          tenantId,
          queue,
        )
        .map((r) => this.rowTo(r)),
    );
  }

  listResolved(tenantId: string, limit = 1000): Promise<Escalation[]> {
    return this.db.exclusive(() =>
      this.db
        .all<EscalationRow>(
          `SELECT * FROM escalations WHERE tenant_id = ? AND status <> 'pending'
           ORDER BY resolved_at IS NULL, resolved_at DESC, rowid DESC LIMIT ?`,
          tenantId,
          limit,
        )
        .map((r) => this.rowTo(r)),
    );
  }

  queueDepths(tenantId: string): Promise<Record<string, number>> {
    return this.db.exclusive(() => {
      const rows = this.db.all<{ queue: string; n: number }>(
        `SELECT queue, count(*) AS n FROM escalations WHERE tenant_id = ? AND status = 'pending' GROUP BY queue`,
        tenantId,
      );
      const out: Record<string, number> = {};
      for (const r of rows) out[r.queue] = Number(r.n);
      return out;
    });
  }

  /** Pending escalations past their SLA deadline that have not yet been breach-notified. */
  findNewBreaches(tenantId: string, nowIso: string): Promise<Escalation[]> {
    return this.db.exclusive(() =>
      this.db
        .all<EscalationRow>(
          `UPDATE escalations SET sla_breach_notified = 1
           WHERE tenant_id = ? AND status = 'pending' AND sla_breach_notified = 0
             AND sla_due_at IS NOT NULL AND sla_due_at <= ?
           RETURNING *`,
          tenantId,
          new Date(nowIso).toISOString(),
        )
        .map((r) => this.rowTo(r)),
    );
  }

  get(tenantId: string, id: string): Promise<Escalation | null> {
    return this.db.exclusive(() => {
      const row = this.db.get<EscalationRow>(
        `SELECT * FROM escalations WHERE tenant_id = ? AND id = ?`,
        tenantId,
        id,
      );
      return row ? this.rowTo(row) : null;
    });
  }

  getByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<Escalation | null> {
    return this.db.exclusive(() => {
      const row = this.db.get<EscalationRow>(
        `SELECT * FROM escalations WHERE tenant_id = ? AND idempotency_key = ?`,
        tenantId,
        idempotencyKey,
      );
      return row ? this.rowTo(row) : null;
    });
  }

  listPending(tenantId: string): Promise<Escalation[]> {
    return this.db.exclusive(() =>
      this.db
        .all<EscalationRow>(
          `SELECT * FROM escalations WHERE tenant_id = ? AND status = 'pending'
           ORDER BY created_at ASC, rowid ASC`,
          tenantId,
        )
        .map((r) => this.rowTo(r)),
    );
  }

  /** Resolve a pending escalation with a human verdict. Only acts on pending rows. */
  resolve(
    tenantId: string,
    id: string,
    input: {
      decision: ResolutionDecision;
      rationale: string;
      resolvedBy: string;
      modifiedAction?: unknown;
    },
  ): Promise<Escalation | null> {
    const status: EscalationStatus =
      input.decision === "approve"
        ? "approved"
        : input.decision === "modify"
          ? "modified"
          : "rejected";
    const resolution = {
      decision: input.decision,
      rationale: input.rationale,
      modifiedAction: input.modifiedAction ?? null,
    };
    return this.db.exclusive(() => {
      const row = this.db.get<EscalationRow>(
        `UPDATE escalations
           SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'pending'
         RETURNING *`,
        status,
        JSON.stringify(resolution),
        input.resolvedBy,
        nowIso(),
        tenantId,
        id,
      );
      return row ? this.rowTo(row) : null;
    });
  }

  /**
   * Atomically claim the right to resume. With a claimId, retries by the same durable
   * continuation retain ownership after a crash while every other claimant is refused.
   * Omitting claimId preserves the original strict first-call-wins behavior.
   */
  claimResume(tenantId: string, id: string, claimId?: string): Promise<Escalation | null> {
    return this.db.exclusive(() => {
      const row = claimId
        ? this.db.get<EscalationRow>(
            `UPDATE escalations
               SET resumed_at = COALESCE(resumed_at, ?),
                   resume_claim_id = COALESCE(resume_claim_id, ?)
             WHERE tenant_id = ? AND id = ? AND status IN ('approved','modified')
               AND (resumed_at IS NULL OR resume_claim_id = ?)
             RETURNING *`,
            nowIso(),
            claimId,
            tenantId,
            id,
            claimId,
          )
        : this.db.get<EscalationRow>(
            `UPDATE escalations SET resumed_at = ?
             WHERE tenant_id = ? AND id = ? AND status IN ('approved','modified') AND resumed_at IS NULL
             RETURNING *`,
            nowIso(),
            tenantId,
            id,
          );
      return row ? this.rowTo(row) : null;
    });
  }
}

// ---------------------------------------------------------------------------------------
// Review notifications
// ---------------------------------------------------------------------------------------

interface NotificationRow {
  id: string;
  tenant_id: string;
  escalation_id: string | null;
  queue: string | null;
  channel: string;
  event: string;
  sent_at: string;
}

/**
 * Embedded review notifier: same per-queue channel policy and recording-first delivery
 * log as `ReviewNotifier`; the webhook post stays best-effort.
 */
export class EmbeddedReviewNotifier implements ReviewNotifierPort {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly db: EmbeddedDb,
    private readonly opts: ReviewNotifierOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private channelsFor(queue: string | null): NotificationChannel[] {
    if (queue && this.opts.queuePolicy?.[queue]) return this.opts.queuePolicy[queue]!;
    return this.opts.defaultChannels ?? ["email"];
  }

  /** Fire an event across the queue's channels; records each delivery and webhooks if configured. */
  async fire(input: {
    tenantId: string;
    event: NotificationEvent;
    escalationId?: string | null;
    queue?: string | null;
  }): Promise<NotificationChannel[]> {
    const channels = this.channelsFor(input.queue ?? null);
    for (const channel of channels) {
      await this.db.exclusive(() => {
        this.db.run(
          `INSERT INTO review_notifications (id, tenant_id, escalation_id, queue, channel, event, sent_at)
           VALUES (?,?,?,?,?,?,?)`,
          randomUUID(),
          input.tenantId,
          input.escalationId ?? null,
          input.queue ?? null,
          channel,
          input.event,
          nowIso(),
        );
      });
      if (channel === "webhook" && this.opts.webhookUrl) {
        await this.fetchImpl(this.opts.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }).catch(() => {
          /* best-effort; the audited record is the source of truth */
        });
      }
    }
    return channels;
  }

  count(tenantId: string, event: NotificationEvent): Promise<number> {
    return this.db.exclusive(() => {
      const row = this.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM review_notifications WHERE tenant_id = ? AND event = ?`,
        tenantId,
        event,
      );
      return Number(row?.n ?? 0);
    });
  }

  list(tenantId: string, limit = 200): Promise<NotificationRecord[]> {
    return this.db.exclusive(() =>
      this.db
        .all<NotificationRow>(
          `SELECT * FROM review_notifications WHERE tenant_id = ?
           ORDER BY sent_at DESC, rowid DESC LIMIT ?`,
          tenantId,
          limit,
        )
        .map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          escalationId: r.escalation_id ?? null,
          queue: r.queue ?? null,
          channel: r.channel as NotificationChannel,
          event: r.event as NotificationEvent,
          sentAt: typeof r.sent_at === "string" ? r.sent_at : new Date(r.sent_at).toISOString(),
        })),
    );
  }
}

// ---------------------------------------------------------------------------------------
// Evidence operations: holds, anchors, claims packs
// ---------------------------------------------------------------------------------------

/** Embedded litigation holds, trusted-time anchors, and claims packs; see `EvidenceOpsStore`. */
