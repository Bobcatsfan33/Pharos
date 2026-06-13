import { type ChainVerification, type SigningProvider, verifyChain } from "@pharos/core";
import type { EvidenceStore } from "./evidenceStore.js";

export interface ChainIntegrityDeps {
  store: EvidenceStore;
  signer: SigningProvider;
  /** Called whenever a chain break is detected. */
  onBreak?: (report: ChainVerification) => void;
}

/**
 * Continuous chain-integrity verification.
 *
 * verifyTenant() reconstructs a tenant's chain from genesis and validates every
 * record's hash, signature, and predecessor link against the published keyset. The
 * background loop runs this for every tenant on an interval and raises an alert on
 * any break. A genesis-to-head verification is exposed to the API for on-demand audit.
 */
export class ChainIntegrityService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ChainIntegrityDeps) {}

  async verifyTenant(tenantId: string): Promise<ChainVerification> {
    const [records, keyset] = await Promise.all([
      this.deps.store.getChain(tenantId),
      this.deps.signer.publishKeyset(),
    ]);
    const report = verifyChain(records, keyset);
    report.tenantId = tenantId;
    if (!report.ok) this.deps.onBreak?.(report);
    return report;
  }

  async verifyAll(): Promise<ChainVerification[]> {
    const tenants = await this.deps.store.listTenants();
    const reports: ChainVerification[] = [];
    for (const tenantId of tenants) reports.push(await this.verifyTenant(tenantId));
    return reports;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.verifyAll().catch((err) => {
        // Never let a background failure crash the process; surface via onBreak.
        this.deps.onBreak?.({
          ok: false,
          tenantId: null,
          recordsChecked: 0,
          firstBrokenSequence: null,
          records: [],
          errors: [`chain integrity sweep failed: ${(err as Error).message}`],
        });
      });
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
