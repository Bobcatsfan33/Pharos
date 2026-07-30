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

  /** Sweep one tenant for new SLA breaches; useful for scoped operations and deterministic drills. */
  async sweepTenant(tenantId: string, now: Date = this.now()): Promise<number> {
    const breaches = await this.deps.escalations.findNewBreaches(tenantId, now.toISOString());
    for (const breach of breaches) {
      await this.deps.notifier.fire({
        tenantId,
        event: "breached",
        escalationId: breach.id,
        queue: breach.queue,
      });
    }
    return breaches.length;
  }

  /** Sweep all tenants for new SLA breaches; returns the number of breach alerts fired. */
  async sweep(): Promise<number> {
    const now = this.now();
    const tenants = await this.deps.tenants.listTenants();
    let fired = 0;
    for (const tenant of tenants) {
      fired += await this.sweepTenant(tenant.tenantId, now);
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
