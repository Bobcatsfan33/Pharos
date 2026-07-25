import { type ChainVerification, type SigningProvider, verifyChain } from "@pharos/core";
import type { EvidenceStore } from "./evidenceStore.js";

/** Minimal anchor shape the integrity sweep needs (a subset of ChainAnchor). */
export interface AnchorSummary {
  sequence: number;
  tsaTime: string;
}

export interface ChainIntegrityDeps {
  store: EvidenceStore;
  signer: SigningProvider;
  /** Trusted-time anchors for a tenant, used to detect missing-anchor gaps. Optional so the
   *  cryptographic sweep still works without the ops store wired in (e.g. tests). */
  listAnchors?: (tenantId: string) => Promise<AnchorSummary[]>;
  /** A tenant's head counts as "stale" if its newest anchor is older than this. Default 2h. */
  anchorMaxAgeMs?: number;
  /** Wall clock (injectable for tests). */
  now?: () => number;
  /** Called whenever a chain break is detected. */
  onBreak?: (report: ChainVerification) => void;
}

/** The cryptographic chain report plus trusted-time anchoring health. `warnings` never flips
 *  `ok` — a missing/stale anchor is an advisory, not a chain break. */
export interface ChainIntegrityReport extends ChainVerification {
  /** Non-fatal advisories (e.g. the head is not yet anchored). */
  warnings: string[];
  anchoring: {
    headSequence: number | null;
    /** Highest sequence covered by any anchor, or null if the tenant has never been anchored. */
    latestAnchorSequence: number | null;
    latestAnchorTime: string | null;
    /** True when an anchor covers the current head (headSequence <= latestAnchorSequence). */
    headAnchored: boolean;
  };
}

const DEFAULT_ANCHOR_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h (2× the default hourly schedule)

/**
 * Continuous chain-integrity verification.
 *
 * verifyTenant() reconstructs a tenant's chain from genesis and validates every record's hash,
 * signature, and predecessor link against the published keyset. It additionally checks
 * trusted-time anchoring health: if the head has advanced past the newest anchor (or the newest
 * anchor is stale, or none exists), it emits a `chainIntegrity` warning — non-fatal, so it does
 * not flip `ok`. The background loop runs this for every tenant and alerts on any break.
 */
export class ChainIntegrityService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ChainIntegrityDeps) {}

  async verifyTenant(tenantId: string): Promise<ChainIntegrityReport> {
    const [records, keyset] = await Promise.all([
      this.deps.store.getChain(tenantId),
      this.deps.signer.publishKeyset(),
    ]);
    const base = verifyChain(records, keyset);
    base.tenantId = tenantId;
    if (!base.ok) this.deps.onBreak?.(base);

    const anchoring = await this.assessAnchoring(tenantId, records.length);
    const warnings = this.anchorWarnings(anchoring, records.length);
    return { ...base, warnings, anchoring };
  }

  private async assessAnchoring(
    tenantId: string,
    recordCount: number,
  ): Promise<ChainIntegrityReport["anchoring"]> {
    const headSequence = recordCount > 0 ? recordCount - 1 : null;
    const empty = { headSequence, latestAnchorSequence: null, latestAnchorTime: null };
    if (!this.deps.listAnchors) return { ...empty, headAnchored: false };

    const anchors = await this.deps.listAnchors(tenantId);
    if (anchors.length === 0) return { ...empty, headAnchored: false };

    const latest = anchors.reduce((a, b) => (b.sequence > a.sequence ? b : a));
    return {
      headSequence,
      latestAnchorSequence: latest.sequence,
      latestAnchorTime: latest.tsaTime,
      headAnchored: headSequence !== null && latest.sequence >= headSequence,
    };
  }

  private anchorWarnings(
    anchoring: ChainIntegrityReport["anchoring"],
    recordCount: number,
  ): string[] {
    if (!this.deps.listAnchors || recordCount === 0) return [];
    const warnings: string[] = [];
    const { headSequence, latestAnchorSequence, latestAnchorTime } = anchoring;

    if (latestAnchorSequence === null) {
      warnings.push(`chain head at sequence ${headSequence} has no trusted-time anchor`);
      return warnings;
    }
    if (headSequence !== null && latestAnchorSequence < headSequence) {
      const behind = headSequence - latestAnchorSequence;
      warnings.push(
        `${behind} record(s) sealed since the last trusted-time anchor ` +
          `(anchor covers sequence ${latestAnchorSequence}, head is ${headSequence})`,
      );
    }
    const maxAge = this.deps.anchorMaxAgeMs ?? DEFAULT_ANCHOR_MAX_AGE_MS;
    const now = (this.deps.now ?? Date.now)();
    if (latestAnchorTime) {
      const ageMs = now - new Date(latestAnchorTime).getTime();
      if (ageMs > maxAge) {
        warnings.push(
          `newest trusted-time anchor is stale (${Math.round(ageMs / 60000)} min old, ` +
            `threshold ${Math.round(maxAge / 60000)} min)`,
        );
      }
    }
    return warnings;
  }

  async verifyAll(): Promise<ChainIntegrityReport[]> {
    const tenants = await this.deps.store.listTenants();
    const reports: ChainIntegrityReport[] = [];
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
