import { z } from "zod";

/**
 * The canonical wire vocabulary of the Pharos PDP contract — the single source every other
 * copy derives from.
 *
 *   - `@pharos/core` composes its sealed `ActionRecord` schema from these enums and
 *     citation shapes (the record's own defaults and sealing fields stay in core).
 *   - `@getpharos/sdk` derives its public TypeScript types from these (type-only; the SDK
 *     ships no runtime dependency).
 *   - `schema/pdp-v1.schema.json` is generated from this module (`pnpm --filter
 *     @getpharos/pdp-spec generate`) and `sdks/python/pharos_sdk/types.py` is generated from
 *     that JSON Schema. A test fails if either generated file drifts.
 *
 * Changing a shape here is changing the wire contract: bump `PDP_SPEC_VERSION` and
 * regenerate. Adding a field is additive for readers (`additionalProperties` is permitted on
 * every object below) and must stay optional.
 */

export const PDP_SPEC_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** What the PDP decided. */
export const Decision = z.enum(["allow", "block", "modify", "escalate"]);
export type Decision = z.infer<typeof Decision>;

/** Whether the action can be undone after it executes. */
export const Reversibility = z.enum(["reversible", "irreversible"]);
export type Reversibility = z.infer<typeof Reversibility>;

/** Where a human sits relative to the action. */
export const OversightMode = z.enum([
  "autonomous", // no human in the path
  "human_in_loop", // human approves before execution
  "human_on_loop", // human monitors and can intervene
]);
export type OversightMode = z.infer<typeof OversightMode>;

/** Set when a deadline or dependency fault forced the decision; null otherwise. */
export const FailMode = z.enum(["fail_open", "fail_closed"]).nullable();
export type FailMode = z.infer<typeof FailMode>;

/** Highest cascade tier reached: 1 deterministic, 2 statistical, 3 judge, "human" review. */
export const TierReached = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("human")]);
export type TierReached = z.infer<typeof TierReached>;

/** Signature algorithm of an evidence binding or a published key. */
export const SignatureAlgorithm = z.enum(["ed25519", "ecdsa-p256"]);
export type SignatureAlgorithm = z.infer<typeof SignatureAlgorithm>;

// ---------------------------------------------------------------------------
// Shared object shapes
// ---------------------------------------------------------------------------

/** A rule the verdict relied on, naming its pack and, where it has one, the clause. */
export const RuleCitationSchema = z.object({
  /** Rule identifier within its pack (e.g. "finra-2210-promissory"). */
  ruleId: z.string().min(1),
  /** Regulation pack the rule belongs to (e.g. "finra", "hipaa"). */
  pack: z.string().min(1),
  /** Specific clause cited (e.g. "FINRA Rule 2210(d)(1)(B)"). */
  clause: z.string().optional(),
  /** Examiner-readable explanation of why the rule applied. */
  description: z.string().optional(),
});
export type RuleCitation = z.infer<typeof RuleCitationSchema>;

/** The model behind the agent, when the caller reports it. */
export const ModelMetadataSchema = z.object({
  provider: z.string(),
  model: z.string(),
  version: z.string().optional(),
});
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

/** The caller's declaration of what the action can affect. */
export const BlastRadiusInputSchema = z.object({
  financialAmount: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  reversibility: Reversibility,
  /** Free-form scope of impact (recipients, accounts, records touched). */
  notes: z.string().optional(),
});
export type BlastRadiusInput = z.infer<typeof BlastRadiusInputSchema>;

/** The mandate the caller says the agent is acting under. */
export const MandateInputSchema = z.object({
  id: z.string().min(1),
  /** Human-readable scope of authority granted to the agent. */
  scope: z.string(),
  /** Quantitative limits (e.g. { maxAmount: 25000, currency: "USD" }). */
  limits: z.record(z.string(), z.unknown()).optional(),
  /** Who granted the mandate (principal/role). */
  grantor: z.string(),
  /** ISO-8601 expiry; null or absent = no expiry. */
  expiresAt: z.string().nullable().optional(),
  /** Mandate document version. */
  version: z.string().optional(),
});
export type MandateInput = z.infer<typeof MandateInputSchema>;

/** What the agent intends to do. */
export const ActionInputSchema = z.object({
  /** Stable identifier for the kind of action (e.g. "email.send", "payment.transfer"). */
  type: z.string().min(1),
  /** The agent that emitted the action. */
  agentId: z.string().min(1),
  /** Optional grouping for a multi-step agent workflow. */
  sessionId: z.string().optional(),
  /** Opaque action payload (tool args, message body, transfer details, ...). */
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type ActionInput = z.infer<typeof ActionInputSchema>;

/** The liability context that governs the action. */
export const LiabilityInputSchema = z.object({
  mandate: MandateInputSchema.nullable().optional(),
  oversightMode: OversightMode,
  blastRadius: BlastRadiusInputSchema,
  modelMetadata: ModelMetadataSchema.nullable().optional(),
});
export type LiabilityInput = z.infer<typeof LiabilityInputSchema>;

/** Latency accounting for one verdict, milliseconds. */
export const VerdictLatencySchema = z.object({
  totalMs: z.number().nonnegative(),
  /** Per-tier wall time, keyed `"1"`, `"2"`, `"3"` and `"3/<judgeId>"` for each Tier-3 judge. */
  perTier: z.record(z.string(), z.number().nonnegative()).optional(),
  deadlineMs: z.number().positive(),
  deadlineBreached: z.boolean(),
});
export type VerdictLatency = z.infer<typeof VerdictLatencySchema>;

/** The verdict Pharos returns from `/v1/actions`. */
export const VerdictSchema = z.object({
  decision: Decision,
  tierReached: TierReached,
  /** Composite risk score in [0,1]. */
  riskScore: z.number().min(0).max(1),
  ruleCitations: z.array(RuleCitationSchema),
  failMode: FailMode,
  /** Registry id of the Tier-3 judge that produced the verdict, when reached. */
  judgeVersion: z.string().nullable(),
  latency: VerdictLatencySchema,
});
export type Verdict = z.infer<typeof VerdictSchema>;

// ---------------------------------------------------------------------------
// The open PDP exchange
// ---------------------------------------------------------------------------

/** A PDP request: the vendor-neutral subset of a Pharos submission. */
export const PdpRequestSchema = z.object({
  action: z.object({
    type: z.string().min(1),
    agentId: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  liability: z.object({
    mandate: z
      .object({ id: z.string().min(1), limits: z.record(z.string(), z.unknown()).optional() })
      .nullable()
      .optional(),
    oversightMode: OversightMode,
    blastRadius: BlastRadiusInputSchema,
  }),
  /** Deadline within which the PDP MUST respond (default 800ms). */
  deadlineMs: z.number().positive().optional(),
});
export type PdpRequest = z.infer<typeof PdpRequestSchema>;

/** A signature binding the verdict to a sealed evidence record. */
export const PdpEvidenceBindingSchema = z.object({
  algorithm: SignatureAlgorithm,
  /** SHA-256 (hex) of the sealed record content. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  keyId: z.string().min(1),
  /** Base64 signature. */
  signature: z.string().min(1),
});
export type PdpEvidenceBinding = z.infer<typeof PdpEvidenceBindingSchema>;

/** A PDP response under the open contract. */
export const PdpResponseSchema = z.object({
  specVersion: z.literal(PDP_SPEC_VERSION),
  decision: Decision,
  tierReached: TierReached,
  riskScore: z.number().min(0).max(1),
  ruleCitations: z.array(RuleCitationSchema),
  failMode: FailMode,
  judgeVersion: z.string().nullable(),
  latency: z.object({
    totalMs: z.number().nonnegative(),
    deadlineMs: z.number().positive(),
    deadlineBreached: z.boolean(),
  }),
  /** Present when the PDP seals evidence; absent otherwise. */
  evidenceBinding: PdpEvidenceBindingSchema.optional(),
});
export type PdpResponse = z.infer<typeof PdpResponseSchema>;

/**
 * Every named schema, in the order they appear in the generated JSON Schema. The generator
 * and the drift test both read this map, so a schema added here is published automatically.
 */
export const WIRE_SCHEMAS = {
  Decision,
  Reversibility,
  OversightMode,
  FailMode,
  TierReached,
  SignatureAlgorithm,
  RuleCitation: RuleCitationSchema,
  ModelMetadata: ModelMetadataSchema,
  BlastRadiusInput: BlastRadiusInputSchema,
  MandateInput: MandateInputSchema,
  ActionInput: ActionInputSchema,
  LiabilityInput: LiabilityInputSchema,
  VerdictLatency: VerdictLatencySchema,
  Verdict: VerdictSchema,
  PdpRequest: PdpRequestSchema,
  PdpEvidenceBinding: PdpEvidenceBindingSchema,
  PdpResponse: PdpResponseSchema,
} as const;

/** Render the wire contract as one JSON Schema document with a `$defs` entry per schema. */
export function toJsonSchemaDocument(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(WIRE_SCHEMAS)) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    uri: (id) => `#/$defs/${id}`,
    target: "draft-2020-12",
    // Readers must tolerate fields they do not know; the contract is additive.
    unrepresentable: "any",
  });
  const defs: Record<string, unknown> = {};
  for (const id of Object.keys(WIRE_SCHEMAS)) {
    const { $schema: _dropped, $id: _id, ...rest } = schemas[id] as Record<string, unknown>;
    defs[id] = relaxAdditionalProperties(rest);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://getpharos.dev/schemas/pdp-v${PDP_SPEC_VERSION}.json`,
    title: "Pharos PDP wire contract",
    description:
      "Generated from packages/pdp-spec/src/schema.ts. Objects accept additional properties: the contract is additive, and readers must ignore fields they do not know.",
    version: PDP_SPEC_VERSION,
    $defs: defs,
  };
}

function relaxAdditionalProperties(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relaxAdditionalProperties);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "additionalProperties" && value === false) continue;
    out[key] = relaxAdditionalProperties(value);
  }
  return out;
}
