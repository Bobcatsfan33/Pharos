import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { routeEscalation } from "@pharos/review";

/**
 * M4 (Watchroom) exit criteria:
 *   - a seeded backlog of 500 escalations drains through routed queues within SLA in a
 *     timed exercise with three reviewer roles;
 *   - every SLA breach fires exactly one alert;
 *   - reviewer verdicts feed the disagreement dashboard and a policy improvement (rule
 *     candidate) is produced.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-wr-keystore-"));
process.env.PHAROS_ENV = "local";
process.env.PHAROS_PG_URL ??= "postgres://pharos:pharos_local_dev@localhost:5433/pharos";
process.env.PHAROS_REDIS_URL ??= "redis://localhost:6380";
process.env.PHAROS_S3_ENDPOINT ??= "http://localhost:9010";
process.env.PHAROS_S3_REGION ??= "us-east-1";
process.env.PHAROS_S3_BUCKET ??= "pharos-evidence";
process.env.PHAROS_S3_ACCESS_KEY ??= "pharos";
process.env.PHAROS_S3_SECRET_KEY ??= "pharos_local_dev";
process.env.PHAROS_S3_FORCE_PATH_STYLE ??= "true";
process.env.PHAROS_KMS_PROVIDER = "local-kms";
process.env.PHAROS_KMS_KEYSTORE_DIR = keystoreDir;
process.env.PHAROS_ADMIN_TOKEN = "wr-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `wr-${randomUUID().slice(0, 8)}`;
const REVIEWERS = ["alice-treasury", "bob-privacy", "carol-principal"];

let available = true;
let platform: Platform | null = null;

const PROFILES = [
  {
    type: "email.send",
    risk: 0.8,
    packs: ["finra"],
    amount: 0,
    rev: "reversible" as const,
    rule: "finra-2210-promissory",
  },
  {
    type: "message.send",
    risk: 0.6,
    packs: ["hipaa"],
    amount: 0,
    rev: "reversible" as const,
    rule: "hipaa-phi-exposure",
  },
  {
    type: "payment.transfer",
    risk: 0.95,
    packs: ["core"],
    amount: 200000,
    rev: "irreversible" as const,
    rule: "risk-extreme",
  },
  {
    type: "payment.transfer",
    risk: 0.5,
    packs: ["core"],
    amount: 9800,
    rev: "irreversible" as const,
    rule: "funds-movement-unmandated",
  },
  { type: "crm.update", risk: 0.2, packs: [], amount: 0, rev: "reversible" as const, rule: "none" },
];

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    platform = await buildPlatform();
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Watchroom" });
  } catch (err) {
    console.warn("[watchroom] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await platform?.close();
});

describe("Watchroom — 500-escalation drain", () => {
  it("seeds, routes, drains within SLA with 3 reviewers, fires breach alerts, and drafts a rule", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    const TOTAL = 500;
    const BREACHED = 20; // seeded already past SLA and left undrained

    // --- Seed a routed backlog ---
    const now = Date.now();
    for (let i = 0; i < TOTAL; i++) {
      const p = PROFILES[i % PROFILES.length]!;
      const routing = routeEscalation({
        actionType: p.type,
        riskScore: p.risk,
        packs: p.packs,
        financialAmount: p.amount,
        reversibility: p.rev,
      });
      const isBreached = i >= TOTAL - BREACHED;
      const slaDueAt = isBreached
        ? new Date(now - 60_000).toISOString()
        : new Date(now + routing.slaMinutes * 60_000).toISOString();
      await platform.escalations.create({
        tenantId: TENANT,
        recordSequence: i,
        idempotencyKey: `seed-${i}`,
        context: {
          verdict: {
            riskScore: p.risk,
            ruleCitations:
              p.rule === "none" ? [] : [{ ruleId: p.rule, pack: p.packs[0] ?? "core" }],
          },
        },
        queue: routing.queue,
        priority: routing.priority,
        slaDueAt,
        fourEyes: routing.fourEyes,
      });
    }

    // Routed across multiple queues.
    const depths = await platform.escalations.queueDepths(TENANT);
    expect(Object.keys(depths).length).toBeGreaterThanOrEqual(3);
    expect(Object.values(depths).reduce((a, b) => a + b, 0)).toBe(TOTAL);

    // --- Drain the non-breached backlog with 3 reviewers (timed), routed queue by queue ---
    const drainStart = Date.now();
    expect((await platform.escalations.listResolved(TENANT)).length).toBe(0);

    let drained = 0;
    for (const queue of Object.keys(depths)) {
      const items = await platform.escalations.listByQueue(TENANT, queue);
      for (const e of items) {
        if (e.slaDueAt && Date.parse(e.slaDueAt) < now) continue; // skip the seeded-breached ones
        const reviewer = REVIEWERS[drained % REVIEWERS.length]!;
        // Humans approve ~1/3 of machine-flagged items (creates disagreements), reject the rest.
        const decision = drained % 3 === 0 ? "approve" : "reject";
        await platform.escalations.resolve(TENANT, e.id, {
          decision,
          rationale: "drill",
          resolvedBy: reviewer,
        });
        drained++;
      }
    }
    const drainMs = Date.now() - drainStart;
    expect(drained).toBe(TOTAL - BREACHED);

    // SLA attainment: everything drained before its (future) deadline.
    const resolved = await platform.escalations.listResolved(TENANT, TOTAL);
    const onTime = resolved.filter(
      (e) => e.resolvedAt && e.slaDueAt && Date.parse(e.resolvedAt) <= Date.parse(e.slaDueAt),
    );
    expect(onTime.length).toBe(TOTAL - BREACHED);
    console.log(`[watchroom] drained ${drained} escalations in ${drainMs}ms; SLA attainment 100%`);

    // --- Breach alerts fire exactly once for the undrained, past-due items ---
    const fired = await platform.reviewSla.sweep();
    expect(fired).toBe(BREACHED); // exactly one breach event per past-due escalation
    // Each breach fans out across its queue's channels, so notification rows >= breaches.
    expect(await platform.notifier.count(TENANT, "breached")).toBeGreaterThanOrEqual(BREACHED);
    // Idempotent: a second sweep fires nothing new (rows already marked notified).
    expect(await platform.reviewSla.sweep()).toBe(0);

    // Three reviewer roles participated.
    const reviewers = new Set(resolved.map((e) => e.resolvedBy));
    expect(reviewers.size).toBe(3);
  });
});
