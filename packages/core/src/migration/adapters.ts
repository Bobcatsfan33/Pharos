import { randomUUID } from "node:crypto";
import {
  type ActionRecordContent,
  ActionRecordContentSchema,
  type VerdictDecision,
  type OversightMode,
} from "../schema/actionRecord.js";
import { ACTION_RECORD_SCHEMA_VERSION } from "../schema/version.js";
import {
  type FlightlineEvent,
  FlightlineEventSchema,
  type LighthouseVerdict,
  LighthouseVerdictSchema,
} from "./legacy.js";

const DEADLINE_MS = 800;

function mapLighthouseDecision(d: LighthouseVerdict["decision"]): VerdictDecision {
  switch (d) {
    case "allow":
      return "allow";
    case "deny":
      return "block";
    case "review":
      return "escalate";
    case "transform":
      return "modify";
  }
}

function mapOversight(o: FlightlineEvent["oversight"]): OversightMode {
  switch (o) {
    case "autonomous":
      return "autonomous";
    case "in_loop":
      return "human_in_loop";
    case "on_loop":
      return "human_on_loop";
  }
}

/**
 * Translate an AI Lighthouse verdict into unified v1 content.
 *
 * Lighthouse records carry rich verdict context but no liability context; we fill
 * the liability half with conservative, explicit defaults (autonomous oversight,
 * reversible zero-blast-radius, no mandate). The resulting content is unsealed —
 * the platform assigns it a sequence and re-seals it into the tenant chain on load.
 */
export function fromLighthouseVerdict(
  raw: unknown,
  opts: { tenantId: string; sequence: number },
): ActionRecordContent {
  const v = LighthouseVerdictSchema.parse(raw);
  const content: ActionRecordContent = {
    schemaVersion: ACTION_RECORD_SCHEMA_VERSION,
    id: randomUUID(),
    tenantId: opts.tenantId,
    sequence: opts.sequence,
    action: {
      type: v.action_type,
      agentId: v.agent,
      payload: v.action_payload,
      emittedAt: v.ts,
    },
    verdict: {
      decision: mapLighthouseDecision(v.decision),
      tierReached: v.tier,
      ruleCitations: v.citations.map((c) => ({
        ruleId: c.rule,
        pack: c.source ?? "legacy-lighthouse",
        description: c.note,
      })),
      riskScore: v.score,
      failMode: v.fallback_mode === "open" ? "fail_open" : v.fallback_mode === "closed" ? "fail_closed" : null,
      judgeVersion: v.model_id,
      latency: { totalMs: 0, perTier: {}, deadlineMs: DEADLINE_MS, deadlineBreached: false },
    },
    liability: {
      mandate: null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
    },
    sealedAt: v.ts,
  };
  return ActionRecordContentSchema.parse(content);
}

/**
 * Translate a Flightline liability event into unified v1 content.
 *
 * Flightline records carry rich liability context but only a coarse decision; we
 * synthesize a minimal verdict context (allowed, tier 1, no citations) preserving
 * the original mandate, oversight, blast radius, and model metadata.
 */
export function fromFlightlineEvent(
  raw: unknown,
  opts: { tenantId?: string; sequence: number },
): ActionRecordContent {
  const e = FlightlineEventSchema.parse(raw);
  const content: ActionRecordContent = {
    schemaVersion: ACTION_RECORD_SCHEMA_VERSION,
    id: randomUUID(),
    tenantId: opts.tenantId ?? e.tenant,
    sequence: opts.sequence,
    action: {
      type: e.operation,
      agentId: e.agent_id,
      payload: e.params,
      emittedAt: e.sealed_at,
    },
    verdict: {
      decision: "allow",
      tierReached: 1,
      ruleCitations: [],
      riskScore: 0,
      failMode: null,
      judgeVersion: null,
      latency: { totalMs: 0, perTier: {}, deadlineMs: DEADLINE_MS, deadlineBreached: false },
    },
    liability: {
      mandate: e.mandate
        ? {
            id: e.mandate.mandate_id,
            scope: e.mandate.scope,
            limits: e.mandate.ceiling,
            grantor: e.mandate.granted_by,
            expiresAt: e.mandate.expires,
            version: "1",
          }
        : null,
      oversightMode: mapOversight(e.oversight),
      blastRadius: {
        financialAmount: e.impact.amount,
        currency: e.impact.currency,
        reversibility: e.impact.reversible ? "reversible" : "irreversible",
        notes: e.impact.notes,
      },
      modelMetadata: e.model ? { provider: e.model.vendor, model: e.model.name, version: e.model.ver } : null,
    },
    sealedAt: e.sealed_at,
  };
  return ActionRecordContentSchema.parse(content);
}

/** Export unified content back to the Lighthouse shape (for downstream compatibility). */
export function toLighthouseVerdict(content: ActionRecordContent): LighthouseVerdict {
  const decisionMap: Record<VerdictDecision, LighthouseVerdict["decision"]> = {
    allow: "allow",
    block: "deny",
    escalate: "review",
    modify: "transform",
  };
  return LighthouseVerdictSchema.parse({
    verdict_id: content.id,
    agent: content.action.agentId,
    action_type: content.action.type,
    action_payload: content.action.payload,
    decision: decisionMap[content.verdict.decision],
    tier: content.verdict.tierReached,
    citations: content.verdict.ruleCitations.map((c) => ({ rule: c.ruleId, source: c.pack, note: c.description })),
    score: content.verdict.riskScore,
    fallback_mode:
      content.verdict.failMode === "fail_open" ? "open" : content.verdict.failMode === "fail_closed" ? "closed" : null,
    model_id: content.verdict.judgeVersion,
    ts: content.action.emittedAt,
  });
}

/** Export unified content back to the Flightline shape (for downstream compatibility). */
export function toFlightlineEvent(content: ActionRecordContent): FlightlineEvent {
  const oversightMap: Record<OversightMode, FlightlineEvent["oversight"]> = {
    autonomous: "autonomous",
    human_in_loop: "in_loop",
    human_on_loop: "on_loop",
  };
  return FlightlineEventSchema.parse({
    event_id: content.id,
    tenant: content.tenantId,
    agent_id: content.action.agentId,
    operation: content.action.type,
    params: content.action.payload,
    mandate: content.liability.mandate
      ? {
          mandate_id: content.liability.mandate.id,
          scope: content.liability.mandate.scope,
          ceiling: content.liability.mandate.limits,
          granted_by: content.liability.mandate.grantor,
          expires: content.liability.mandate.expiresAt,
        }
      : null,
    oversight: oversightMap[content.liability.oversightMode],
    impact: {
      amount: content.liability.blastRadius.financialAmount,
      currency: content.liability.blastRadius.currency,
      reversible: content.liability.blastRadius.reversibility === "reversible",
      notes: content.liability.blastRadius.notes,
    },
    model: content.liability.modelMetadata
      ? {
          vendor: content.liability.modelMetadata.provider,
          name: content.liability.modelMetadata.model,
          ver: content.liability.modelMetadata.version,
        }
      : null,
    sealed_at: content.sealedAt,
  });
}
