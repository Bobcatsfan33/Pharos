import { z } from "zod";

/**
 * Legacy schemas the unification migrates away from.
 *
 * Pharos is the convergence of two products:
 *   - AI Lighthouse — a verdict/decision plane (became Pharos Beam)
 *   - Flightline    — an evidence/liability plane (became Pharos Ledger)
 *
 * Each had its own record shape. These Zod schemas describe those shapes so the
 * adapters in ./adapters.ts can translate either into the unified ActionRecord v1
 * content (and back, for export compatibility).
 */

/** AI Lighthouse verdict record (decision-centric). */
export const LighthouseVerdictSchema = z.object({
  verdict_id: z.string(),
  agent: z.string(),
  action_type: z.string(),
  action_payload: z.record(z.string(), z.unknown()).default({}),
  decision: z.enum(["allow", "deny", "review", "transform"]),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("human")]),
  citations: z
    .array(z.object({ rule: z.string(), source: z.string().optional(), note: z.string().optional() }))
    .default([]),
  score: z.number().min(0).max(1),
  fallback_mode: z.enum(["open", "closed"]).nullable().default(null),
  model_id: z.string().nullable().default(null),
  ts: z.string(),
});
export type LighthouseVerdict = z.infer<typeof LighthouseVerdictSchema>;

/** Flightline liability/evidence record (accountability-centric). */
export const FlightlineEventSchema = z.object({
  event_id: z.string(),
  tenant: z.string(),
  agent_id: z.string(),
  operation: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  mandate: z
    .object({
      mandate_id: z.string(),
      scope: z.string().default(""),
      ceiling: z.record(z.string(), z.unknown()).default({}),
      granted_by: z.string().default("unknown"),
      expires: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  oversight: z.enum(["autonomous", "in_loop", "on_loop"]).default("autonomous"),
  impact: z.object({
    amount: z.number().nonnegative().default(0),
    currency: z.string().default("USD"),
    reversible: z.boolean().default(true),
    notes: z.string().optional(),
  }),
  model: z
    .object({ vendor: z.string(), name: z.string(), ver: z.string().optional() })
    .nullable()
    .default(null),
  sealed_at: z.string(),
});
export type FlightlineEvent = z.infer<typeof FlightlineEventSchema>;
