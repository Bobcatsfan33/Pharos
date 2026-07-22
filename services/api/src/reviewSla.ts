import type { EscalationStore, ReviewNotifier, TenantStore } from "@pharos/storage";

/**
 * SLA engine. Periodically finds pending escalations that have breached their SLA and fires
 * a breach alert for each (recorded in the notification audit). findNewBreaches marks rows
 * atomically so each breach is alerted exactly once.
 */
export class ReviewSlaService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      tenants: TenantStore;
      escalations: EscalationStore;
      notifier: ReviewNotifier;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Sweep all tenants for new SLA breaches; returns the number of breach alerts fired. */
  async sweep(): Promise<number> {
    const nowIso = this.now().toISOString();
    const tenants = await this.deps.tenants.listTenants();
    let fired = 0;
    for (const tenant of tenants) {
      const breaches = await this.deps.escalations.findNewBreaches(tenant.tenantId, nowIso);
      for (const b of breaches) {
        await this.deps.notifier.fire({
          tenantId: tenant.tenantId,
          event: "breached",
          escalationId: b.id,
          queue: b.queue,
        });
        fired += 1;
      }
    }
    return fired;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        console.error("[review-sla] sweep failed", (err as Error).message),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
