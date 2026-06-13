import type { FlightlineEvent } from "@pharos/core";

/** Flightline legacy demo dataset (liability plane) used to validate migration. */
export const FLIGHTLINE_DEMO: FlightlineEvent[] = [
  {
    event_id: "fl-0001",
    tenant: "acme-bank",
    agent_id: "treasury-agent",
    operation: "payment.transfer",
    params: { to: "vendor-x", amount: 12000 },
    mandate: {
      mandate_id: "m-treasury-01",
      scope: "vendor payments up to 25k",
      ceiling: { maxAmount: 25000, currency: "USD" },
      granted_by: "cfo",
      expires: "2026-12-31T00:00:00.000Z",
    },
    oversight: "in_loop",
    impact: { amount: 12000, currency: "USD", reversible: false, notes: "wire to vendor-x" },
    model: { vendor: "anthropic", name: "claude-opus-4-8", ver: "1m" },
    sealed_at: "2026-02-02T09:00:00.000Z",
  },
  {
    event_id: "fl-0002",
    tenant: "acme-bank",
    agent_id: "treasury-agent",
    operation: "payment.transfer",
    params: { to: "vendor-y", amount: 30000 },
    mandate: {
      mandate_id: "m-treasury-01",
      scope: "vendor payments up to 25k",
      ceiling: { maxAmount: 25000, currency: "USD" },
      granted_by: "cfo",
      expires: "2026-12-31T00:00:00.000Z",
    },
    oversight: "in_loop",
    impact: { amount: 30000, currency: "USD", reversible: false },
    model: { vendor: "anthropic", name: "claude-opus-4-8", ver: "1m" },
    sealed_at: "2026-02-02T09:05:00.000Z",
  },
  {
    event_id: "fl-0003",
    tenant: "acme-bank",
    agent_id: "comms-agent",
    operation: "email.send",
    params: { to: "client@example.com" },
    mandate: null,
    oversight: "on_loop",
    impact: { amount: 0, currency: "USD", reversible: true },
    model: null,
    sealed_at: "2026-02-02T09:10:00.000Z",
  },
];
