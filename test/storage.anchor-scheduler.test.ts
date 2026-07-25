import { describe, it, expect } from "vitest";
import { AnchorScheduler } from "@pharos/storage";

/**
 * Hermetic unit tests for the scheduled-anchoring sweep. The scheduler is decoupled from the
 * platform (it takes a tenant lister + an anchor function), so we drive it with fakes and assert
 * the two guarantees the ops path relies on: every tenant is anchored once per sweep, and one
 * tenant's failure never starves the rest.
 */
describe("AnchorScheduler.anchorAll", () => {
  it("anchors every tenant's head exactly once per sweep", async () => {
    const calls: string[] = [];
    const scheduler = new AnchorScheduler({
      listTenants: async () => ["t1", "t2", "t3"],
      anchorTenant: async (tenantId) => {
        calls.push(tenantId);
        return { sequence: 5, headHash: `head-${tenantId}` };
      },
    });

    const results = await scheduler.anchorAll();

    expect(calls).toEqual(["t1", "t2", "t3"]);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.anchored?.headHash.startsWith("head-"))).toBe(true);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it("reports a null anchor for a tenant with no records (does not throw)", async () => {
    const scheduler = new AnchorScheduler({
      listTenants: async () => ["empty"],
      anchorTenant: async () => null,
    });
    const [result] = await scheduler.anchorAll();
    expect(result).toEqual({ tenantId: "empty", anchored: null });
  });

  it("isolates a per-tenant failure so the rest of the sweep still runs", async () => {
    const errors: string[] = [];
    const scheduler = new AnchorScheduler({
      listTenants: async () => ["ok1", "boom", "ok2"],
      anchorTenant: async (tenantId) => {
        if (tenantId === "boom") throw new Error("TSA unreachable");
        return { sequence: 1, headHash: tenantId };
      },
      onError: (tenantId) => errors.push(tenantId),
    });

    const results = await scheduler.anchorAll();

    expect(results.map((r) => r.tenantId)).toEqual(["ok1", "boom", "ok2"]);
    expect(results[0]!.anchored).not.toBeNull();
    expect(results[1]!).toMatchObject({ tenantId: "boom", anchored: null });
    expect(results[1]!.error).toMatch(/TSA unreachable/);
    expect(results[2]!.anchored).not.toBeNull();
    expect(errors).toEqual(["boom"]);
  });

  it("start() is idempotent and stop() is safe to call when not running", () => {
    const scheduler = new AnchorScheduler({
      listTenants: async () => [],
      anchorTenant: async () => null,
    });
    expect(() => scheduler.stop()).not.toThrow();
    scheduler.start(3_600_000);
    scheduler.start(3_600_000); // second start is a no-op (single timer)
    expect(() => scheduler.stop()).not.toThrow();
  });
});
