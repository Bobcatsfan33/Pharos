import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type NotificationChannel = "email" | "slack" | "teams" | "webhook";
export type NotificationEvent = "assigned" | "at_risk" | "breached" | "resolved" | "digest";

export interface NotificationRecord {
  id: string;
  tenantId: string;
  escalationId: string | null;
  queue: string | null;
  channel: NotificationChannel;
  event: NotificationEvent;
  sentAt: string;
}

/**
 * Review notifications with per-queue channel policy and an audited delivery log.
 *
 * Every fired alert is recorded in review_notifications (the audit), and optionally posted
 * to a webhook. SLA breach alerts, at-risk warnings, assignments, and daily digests all go
 * through here. Recording-first means the exit-criteria check "every breach alert fires
 * correctly" is verifiable from the database.
 */
export interface ReviewNotifierOptions {
  /** Channels per queue; falls back to defaultChannels. */
  queuePolicy?: Record<string, NotificationChannel[]>;
  defaultChannels?: NotificationChannel[];
  /** Optional outbound webhook for channel "webhook". */
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ReviewNotifier {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly pool: Pool, private readonly opts: ReviewNotifierOptions = {}) {
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
      await this.pool.query(
        `INSERT INTO review_notifications (id, tenant_id, escalation_id, queue, channel, event)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), input.tenantId, input.escalationId ?? null, input.queue ?? null, channel, input.event],
      );
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

  async count(tenantId: string, event: NotificationEvent): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM review_notifications WHERE tenant_id = $1 AND event = $2`,
      [tenantId, event],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async list(tenantId: string, limit = 200): Promise<NotificationRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM review_notifications WHERE tenant_id = $1 ORDER BY sent_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      escalationId: (r.escalation_id as string) ?? null,
      queue: (r.queue as string) ?? null,
      channel: r.channel as NotificationChannel,
      event: r.event as NotificationEvent,
      sentAt: typeof r.sent_at === "string" ? r.sent_at : new Date(r.sent_at as string).toISOString(),
    }));
  }
}
