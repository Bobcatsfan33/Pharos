import { z } from "zod";
import { ACTION_RECORD_SCHEMA_VERSION } from "./version.js";

/**
 * The unified ActionRecord — the universal event of the Pharos platform.
 *
 * One event, two consumers: it carries the Beam (Decide) verdict context and the
 * Ledger (Prove) liability context in a single schema, signed once and chained once.
 * An agent action can never be governed without being recorded, or recorded without
 * its governing context.
 *
 * Layout:
 *   content  -> everything that is hashed and signed (the immutable evidence body)
 *   seal     -> the cryptographic envelope (hash chain linkage + signature + key id)
 *
 * The seal is computed *over* the content. A third party verifies a record by
 * canonicalizing `content`, hashing it, checking it equals `seal.contentHash`,
 * verifying `seal.signature` against the published public key for `seal.keyId`, and
 * checking `seal.prevHash` links to the prior record. No Pharos infrastructure is
 * required to verify — only the public key and the documented procedure.
 */

// ---------------------------------------------------------------------------
// Action core — what the agent is trying to do.
// ---------------------------------------------------------------------------
export const ActionIntentSchema = z.object({
  /** Stable identifier for the kind of action (e.g. "email.send", "payment.transfer"). */
  type: z.string().min(1),
  /** The agent that emitted the action. */
  agentId: z.string().min(1),
  /** Optional grouping for a multi-step agent workflow. */
  sessionId: z.string().optional(),
  /** Opaque action payload (tool args, message body, transfer details, ...). */
  payload: z.record(z.unknown()).default({}),
  /** ISO-8601 timestamp the agent emitted the action. */
  emittedAt: z.string().datetime(),
});
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

// ---------------------------------------------------------------------------
// Verdict context (Beam / Decide). Filled by the decision cascade.
// ---------------------------------------------------------------------------
export const VerdictDecision = z.enum(["allow", "block", "modify", "escalate"]);
export type VerdictDecision = z.infer<typeof VerdictDecision>;

export const FailMode = z.enum(["fail_open", "fail_closed"]).nullable();
export type FailMode = z.infer<typeof FailMode>;

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

export const VerdictContextSchema = z.object({
  decision: VerdictDecision,
  /** Highest tier the cascade reached: 1 deterministic, 2 statistical, 3 judge, "human" review. */
  tierReached: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("human")]),
  /** Rules cited by the verdict, each naming its clause. */
  ruleCitations: z.array(RuleCitationSchema).default([]),
  /** Composite risk score in [0,1] produced by the cascade. */
  riskScore: z.number().min(0).max(1),
  /** Set when the deadline forced a fail-open / fail-closed decision; null otherwise. */
  failMode: FailMode.default(null),
  /** Registry id of the Tier-3 judge that produced the verdict, when reached. */
  judgeVersion: z.string().nullable().default(null),
  /** Latency budget accounting, milliseconds. */
  latency: z.object({
    totalMs: z.number().nonnegative(),
    perTier: z.record(z.number().nonnegative()).default({}),
    deadlineMs: z.number().positive(),
    deadlineBreached: z.boolean().default(false),
  }),
});
export type VerdictContext = z.infer<typeof VerdictContextSchema>;

// ---------------------------------------------------------------------------
// Liability context (Ledger / Prove). Binds the action to its mandate & blast radius.
// ---------------------------------------------------------------------------
export const Reversibility = z.enum(["reversible", "irreversible"]);
export type Reversibility = z.infer<typeof Reversibility>;

export const OversightMode = z.enum([
  "autonomous", // no human in the path
  "human_in_loop", // human approves before execution
  "human_on_loop", // human monitors and can intervene
]);
export type OversightMode = z.infer<typeof OversightMode>;

export const MandateBindingSchema = z.object({
  id: z.string().min(1),
  /** Human-readable scope of authority granted to the agent. */
  scope: z.string(),
  /** Quantitative limits (e.g. { maxAmount: 25000, currency: "USD" }). */
  limits: z.record(z.unknown()).default({}),
  /** Who granted the mandate (principal/role). */
  grantor: z.string(),
  /** ISO-8601 expiry; null = no expiry. */
  expiresAt: z.string().datetime().nullable().default(null),
  /** Mandate document version bound into this record. */
  version: z.string().default("1"),
});
export type MandateBinding = z.infer<typeof MandateBindingSchema>;

export const BlastRadiusSchema = z.object({
  /** Financial exposure of the action. */
  financialAmount: z.number().nonnegative().default(0),
  currency: z.string().default("USD"),
  reversibility: Reversibility,
  /** Free-form scope of impact (recipients, accounts, records touched). */
  notes: z.string().optional(),
});
export type BlastRadius = z.infer<typeof BlastRadiusSchema>;

export const ModelMetadataSchema = z.object({
  provider: z.string(),
  model: z.string(),
  version: z.string().optional(),
});
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

export const LiabilityContextSchema = z.object({
  mandate: MandateBindingSchema.nullable().default(null),
  oversightMode: OversightMode,
  blastRadius: BlastRadiusSchema,
  modelMetadata: ModelMetadataSchema.nullable().default(null),
});
export type LiabilityContext = z.infer<typeof LiabilityContextSchema>;

// ---------------------------------------------------------------------------
// Content — the signed, hashed evidence body.
// ---------------------------------------------------------------------------
export const ActionRecordContentSchema = z.object({
  schemaVersion: z.literal(ACTION_RECORD_SCHEMA_VERSION),
  /** Globally unique record id (uuid v4). */
  id: z.string().uuid(),
  /** Tenant that owns this record; isolation boundary. */
  tenantId: z.string().min(1),
  /** Per-tenant monotonic sequence number; 0 is genesis. */
  sequence: z.number().int().nonnegative(),
  action: ActionIntentSchema,
  verdict: VerdictContextSchema,
  liability: LiabilityContextSchema,
  /** When the record content was sealed (ISO-8601). */
  sealedAt: z.string().datetime(),
});
export type ActionRecordContent = z.infer<typeof ActionRecordContentSchema>;

// ---------------------------------------------------------------------------
// Seal — the cryptographic envelope.
// ---------------------------------------------------------------------------
export const RecordSealSchema = z.object({
  /** SHA-256 (hex) over canonical JSON of `content`. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** `contentHash` of the previous record in this tenant's chain; GENESIS_HASH for sequence 0. */
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Signature algorithm. */
  algorithm: z.literal("ed25519"),
  /** KMS key id that produced the signature (enables rotation with chain continuity). */
  keyId: z.string().min(1),
  /** Base64 signature over `contentHash` bytes. */
  signature: z.string().min(1),
  /**
   * Seal signature version. Absent = legacy v1 (signature over contentHash
   * only). 2 = signature over the domain-separated {sequence, prevHash,
   * contentHash} message, binding the record to its chain position.
   * The seal is not part of contentHash, so this is hash-compatible with
   * existing chains.
   */
  sigVersion: z.union([z.literal(1), z.literal(2)]).optional(),
});
export type RecordSeal = z.infer<typeof RecordSealSchema>;

export const ActionRecordSchema = z.object({
  content: ActionRecordContentSchema,
  seal: RecordSealSchema,
});
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

/** Genesis predecessor hash for the first record in any tenant chain (64 zeros). */
export const GENESIS_HASH = "0".repeat(64);
