/**
 * Scheduled trusted-time anchoring.
 *
 * Anchoring on demand proves a head existed at a point in time, but only if someone asks. The
 * scheduler closes that gap: it anchors every tenant's current chain head on a fixed interval
 * (default hourly) so the "these records existed before time T" proof is always fresh, and the
 * chain-integrity sweep can flag a tenant whose head has drifted past its last anchor.
 *
 * It is deliberately decoupled from the platform: it takes a tenant lister and an anchor
 * function (the same `anchorHead` used by the on-demand route), so the two paths mint identical
 * anchors. A per-tenant failure never aborts the sweep — it is reported and the loop continues.
 */
export interface AnchorSchedulerDeps {
  /** All tenants that should be anchored. */
  listTenants: () => Promise<string[]>;
  /** Anchor a tenant's current head; returns null when the tenant has no records yet. */
  anchorTenant: (tenantId: string) => Promise<{ sequence: number; headHash: string } | null>;
  /** Called when anchoring a single tenant throws; the sweep still continues. */
  onError?: (tenantId: string, err: unknown) => void;
}

export interface AnchorSweepResult {
  tenantId: string;
  anchored: { sequence: number; headHash: string } | null;
  error?: string;
}

export class AnchorScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: AnchorSchedulerDeps) {}

  /** Anchor every tenant's head once. Isolates per-tenant failures so one bad tenant can't
   *  starve the rest. Returns a per-tenant result (anchored head, or the error message). */
  async anchorAll(): Promise<AnchorSweepResult[]> {
    const tenants = await this.deps.listTenants();
    const results: AnchorSweepResult[] = [];
    for (const tenantId of tenants) {
      try {
        const anchored = await this.deps.anchorTenant(tenantId);
        results.push({ tenantId, anchored });
      } catch (err) {
        this.deps.onError?.(tenantId, err);
        results.push({ tenantId, anchored: null, error: (err as Error).message });
      }
    }
    return results;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.anchorAll().catch((err) => this.deps.onError?.("*", err));
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
