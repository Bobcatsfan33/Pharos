/**
 * Metering & billing for the three-part commercial model: a platform subscription, per-
 * recorded-action metering, and pack / risk-profile subscriptions. Usage is metered from the
 * authoritative recorded-action count, so an invoice reconciles to recorded usage exactly.
 */

export interface PriceBook {
  currency: string;
  platformMonthly: number; // flat platform subscription
  perAction: number; // metered, per recorded ActionRecord
  packMonthly: number; // per active regulation/policy pack
  riskProfileMonthly: number; // per-tenant risk-profile / underwriter-feed subscription
}

export const DEFAULT_PRICEBOOK: PriceBook = {
  currency: "USD",
  platformMonthly: 2500,
  perAction: 0.02,
  packMonthly: 1500,
  riskProfileMonthly: 5000,
};

export interface Usage {
  tenantId: string;
  period: string; // e.g. "2026-07"
  recordedActions: number;
  activePacks: number;
  riskProfileEnabled: boolean;
}

export interface InvoiceLine {
  type: "platform" | "metered_actions" | "packs" | "risk_profile";
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface Invoice {
  tenantId: string;
  period: string;
  currency: string;
  lines: InvoiceLine[];
  total: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeInvoice(usage: Usage, book: PriceBook = DEFAULT_PRICEBOOK): Invoice {
  const lines: InvoiceLine[] = [
    {
      type: "platform",
      description: "Platform subscription",
      quantity: 1,
      unitPrice: book.platformMonthly,
      amount: book.platformMonthly,
    },
    {
      type: "metered_actions",
      description: "Recorded actions (metered)",
      quantity: usage.recordedActions,
      unitPrice: book.perAction,
      amount: round2(usage.recordedActions * book.perAction),
    },
    {
      type: "packs",
      description: "Active regulation/policy packs",
      quantity: usage.activePacks,
      unitPrice: book.packMonthly,
      amount: round2(usage.activePacks * book.packMonthly),
    },
  ];
  if (usage.riskProfileEnabled) {
    lines.push({
      type: "risk_profile",
      description: "Risk-profile / underwriter feed",
      quantity: 1,
      unitPrice: book.riskProfileMonthly,
      amount: book.riskProfileMonthly,
    });
  }
  const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  return { tenantId: usage.tenantId, period: usage.period, currency: book.currency, lines, total };
}

export interface Reconciliation {
  ok: boolean;
  invoicedActions: number;
  recordedActions: number;
  discrepancy: number;
}

/** Reconcile the metered quantity on the invoice against the authoritative recorded count. */
export function reconcile(invoice: Invoice, recordedActions: number): Reconciliation {
  const line = invoice.lines.find((l) => l.type === "metered_actions");
  const invoicedActions = line?.quantity ?? 0;
  const discrepancy = invoicedActions - recordedActions;
  return { ok: discrepancy === 0, invoicedActions, recordedActions, discrepancy };
}
