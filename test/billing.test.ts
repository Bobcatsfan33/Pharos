import { describe, it, expect } from "vitest";
import { computeInvoice, reconcile, DEFAULT_PRICEBOOK } from "@pharos/billing";
import { MetricsRegistry as Reg } from "@pharos/observability";

describe("billing", () => {
  it("computes a three-part invoice", () => {
    const inv = computeInvoice({ tenantId: "t", period: "2026-07", recordedActions: 1000, activePacks: 3, riskProfileEnabled: true });
    const byType = Object.fromEntries(inv.lines.map((l) => [l.type, l.amount]));
    expect(byType.platform).toBe(2500);
    expect(byType.metered_actions).toBe(20); // 1000 * 0.02
    expect(byType.packs).toBe(4500); // 3 * 1500
    expect(byType.risk_profile).toBe(5000);
    expect(inv.total).toBe(12020);
  });

  it("omits the risk-profile line when disabled", () => {
    const inv = computeInvoice({ tenantId: "t", period: "2026-07", recordedActions: 0, activePacks: 0, riskProfileEnabled: false });
    expect(inv.lines.find((l) => l.type === "risk_profile")).toBeUndefined();
    expect(inv.total).toBe(DEFAULT_PRICEBOOK.platformMonthly);
  });

  it("reconciles exactly against the recorded count", () => {
    const inv = computeInvoice({ tenantId: "t", period: "2026-07", recordedActions: 742, activePacks: 2, riskProfileEnabled: true });
    expect(reconcile(inv, 742).ok).toBe(true);
    const off = reconcile(inv, 741);
    expect(off.ok).toBe(false);
    expect(off.discrepancy).toBe(1);
  });
});

// MetricsRegistry is re-exported via billing? No — it's observability. Sanity-check it here too.
describe("observability metrics", () => {
  it("renders Prometheus exposition for counters and histograms", () => {
    const reg = new Reg();
    reg.verdicts.inc({ decision: "block", tier: "3" });
    reg.verdicts.inc({ decision: "allow", tier: "1" }, 2);
    reg.recordsSealed.inc();
    reg.verdictLatency.observe(3.5);
    const text = reg.render();
    expect(text).toContain("# TYPE pharos_verdicts_total counter");
    expect(text).toContain('pharos_verdicts_total{decision="block",tier="3"} 1');
    expect(text).toContain('pharos_verdicts_total{decision="allow",tier="1"} 2');
    expect(text).toContain("pharos_records_sealed_total 1");
    expect(text).toContain("pharos_verdict_latency_ms_count 1");
  });
});
