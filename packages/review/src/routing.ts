/**
 * Queue routing — the human tier as an operating system.
 *
 * Each escalation is routed to a queue by action class, risk, and regulation pack, assigned
 * a priority, and given an SLA deadline. Routing is pure and deterministic so it can be
 * unit-tested and replayed.
 */
export type Queue = "treasury-control" | "privacy-office" | "registered-principal" | "general";

export interface RoutableContext {
  actionType: string;
  riskScore: number;
  /** Regulation packs cited by the verdict (e.g. ["finra"], ["hipaa"]). */
  packs: string[];
  /** Financial blast radius, for priority. */
  financialAmount: number;
  reversibility: "reversible" | "irreversible";
}

export interface RoutingDecision {
  queue: Queue;
  /** 1 = highest priority. */
  priority: number;
  /** Minutes until SLA breach. */
  slaMinutes: number;
  /** Action classes requiring two independent approvers. */
  fourEyes: boolean;
}

/** SLA budget (minutes) by priority. Higher priority = tighter SLA. */
const SLA_BY_PRIORITY: Record<number, number> = { 1: 15, 2: 60, 3: 240, 4: 1440 };

export function routeEscalation(ctx: RoutableContext): RoutingDecision {
  const queue = pickQueue(ctx);
  const priority = pickPriority(ctx);
  const fourEyes =
    queue === "treasury-control" && ctx.financialAmount >= 100_000
      ? true
      : ctx.reversibility === "irreversible" && ctx.financialAmount >= 250_000;
  return { queue, priority, slaMinutes: SLA_BY_PRIORITY[priority] ?? 1440, fourEyes };
}

function pickQueue(ctx: RoutableContext): Queue {
  if (ctx.packs.includes("hipaa")) return "privacy-office";
  if (ctx.packs.includes("finra")) return "registered-principal";
  if (
    ctx.actionType.startsWith("payment.") ||
    ctx.actionType.startsWith("funds.") ||
    ctx.actionType.startsWith("wire.")
  ) {
    return "treasury-control";
  }
  if (
    ctx.actionType.includes("export") ||
    ctx.actionType.includes("pii") ||
    ctx.packs.includes("privacy")
  ) {
    return "privacy-office";
  }
  return "general";
}

function pickPriority(ctx: RoutableContext): number {
  if (
    ctx.riskScore >= 0.9 ||
    (ctx.reversibility === "irreversible" && ctx.financialAmount >= 100_000)
  )
    return 1;
  if (ctx.riskScore >= 0.6 || ctx.financialAmount >= 25_000) return 2;
  if (ctx.riskScore >= 0.3) return 3;
  return 4;
}

export type SlaState = "ok" | "at_risk" | "breached";

/** SLA state given the due time and now. "at_risk" within the last 20% of the window. */
export function slaState(createdAtMs: number, dueAtMs: number, nowMs: number): SlaState {
  if (nowMs >= dueAtMs) return "breached";
  const window = dueAtMs - createdAtMs;
  if (window > 0 && nowMs >= dueAtMs - window * 0.2) return "at_risk";
  return "ok";
}
