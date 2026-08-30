import type { ActionRecord, VerdictDecision } from "@pharos/core";

/**
 * OCSF 1.9 Base Event projection for a governed AI-agent action.
 *
 * OCSF does not yet have a released first-class agent-action class.  Using the
 * concrete Base Event keeps the export valid and vendor-neutral while the
 * Pharos-specific custody fields live under `unmapped.pharos`.  The original
 * action payload is excluded by default so forwarding evidence to a SIEM does
 * not silently create a second sensitive-data store.
 */
export interface OcsfBaseEvent {
  activity_id: 99;
  activity_name: "Govern AI Agent Action";
  category_uid: 0;
  category_name: "Uncategorized";
  class_uid: 0;
  class_name: "Base Event";
  type_uid: 99;
  type_name: "Base Event: Govern AI Agent Action";
  time: number;
  severity_id: 1 | 2 | 3 | 4 | 5;
  severity: "Informational" | "Low" | "Medium" | "High" | "Critical";
  status_id: 1;
  status: "Success";
  action_id: 1 | 2 | 99;
  action: "Allowed" | "Denied" | "Other";
  message: string;
  metadata: {
    product: { name: "Pharos"; vendor_name: "Pharos"; version: string };
    version: "1.9.0";
    log_name: "pharos.action_records";
    original_event_uid: string;
    tenant_uid: string;
    sequence: number;
    logged_time: number;
  };
  unmapped: {
    pharos: {
      schema_version: string;
      agent_id: string;
      session_id?: string;
      action_type: string;
      verdict: VerdictDecision;
      tier_reached: number | "human";
      risk_score: number;
      rule_citations: Array<{ rule_id: string; pack: string; clause?: string }>;
      mandate_id?: string;
      oversight_mode: string;
      blast_radius: {
        financial_amount: number;
        currency: string;
        reversibility: string;
      };
      custody: {
        content_hash: string;
        previous_hash: string;
        signature_algorithm: string;
        signing_key_id: string;
        signature_version?: number;
      };
      action_payload?: Record<string, unknown>;
    };
  };
}

export interface OcsfExportOptions {
  /** Include action arguments in the SIEM event. Off by default to minimize copied sensitive data. */
  includePayload?: boolean;
  /** Product version reported to OCSF consumers. */
  productVersion?: string;
}

const SEVERITIES = ["Informational", "Low", "Medium", "High", "Critical"] as const;

function severityId(decision: VerdictDecision, risk: number): 1 | 2 | 3 | 4 | 5 {
  if (decision === "block" || risk >= 0.9) return 5;
  if (decision === "escalate" || risk >= 0.7) return 4;
  if (decision === "modify" || risk >= 0.4) return 3;
  if (risk >= 0.15) return 2;
  return 1;
}

function actionId(decision: VerdictDecision): 1 | 2 | 99 {
  if (decision === "allow") return 1;
  if (decision === "block") return 2;
  return 99;
}

/** Map a sealed ActionRecord to a stable, payload-minimized OCSF event. */
export function actionRecordToOcsf(
  record: ActionRecord,
  options: OcsfExportOptions = {},
): OcsfBaseEvent {
  const { content, seal } = record;
  const time = Date.parse(content.action.emittedAt);
  const loggedTime = Date.parse(content.sealedAt);
  const severity_id = severityId(content.verdict.decision, content.verdict.riskScore);
  const action_id = actionId(content.verdict.decision);
  const action = action_id === 1 ? "Allowed" : action_id === 2 ? "Denied" : "Other";
  const mandate = content.liability.mandate;

  return {
    activity_id: 99,
    activity_name: "Govern AI Agent Action",
    category_uid: 0,
    category_name: "Uncategorized",
    class_uid: 0,
    class_name: "Base Event",
    type_uid: 99,
    type_name: "Base Event: Govern AI Agent Action",
    time,
    severity_id,
    severity: SEVERITIES[severity_id - 1]!,
    status_id: 1,
    status: "Success",
    action_id,
    action,
    message: `Pharos ${content.verdict.decision} verdict for ${content.action.type}`,
    metadata: {
      product: {
        name: "Pharos",
        vendor_name: "Pharos",
        version: options.productVersion ?? "0.1.0",
      },
      version: "1.9.0",
      log_name: "pharos.action_records",
      original_event_uid: content.id,
      tenant_uid: content.tenantId,
      sequence: content.sequence,
      logged_time: loggedTime,
    },
    unmapped: {
      pharos: {
        schema_version: content.schemaVersion,
        agent_id: content.action.agentId,
        ...(content.action.sessionId ? { session_id: content.action.sessionId } : {}),
        action_type: content.action.type,
        verdict: content.verdict.decision,
        tier_reached: content.verdict.tierReached,
        risk_score: content.verdict.riskScore,
        rule_citations: content.verdict.ruleCitations.map((citation) => ({
          rule_id: citation.ruleId,
          pack: citation.pack,
          ...(citation.clause ? { clause: citation.clause } : {}),
        })),
        ...(mandate ? { mandate_id: mandate.id } : {}),
        oversight_mode: content.liability.oversightMode,
        blast_radius: {
          financial_amount: content.liability.blastRadius.financialAmount,
          currency: content.liability.blastRadius.currency,
          reversibility: content.liability.blastRadius.reversibility,
        },
        custody: {
          content_hash: seal.contentHash,
          previous_hash: seal.prevHash,
          signature_algorithm: seal.algorithm,
          signing_key_id: seal.keyId,
          ...(seal.sigVersion ? { signature_version: seal.sigVersion } : {}),
        },
        ...(options.includePayload ? { action_payload: content.action.payload } : {}),
      },
    },
  };
}
