import type { PdpRequest, PdpResponse } from "./contract.js";
import { validatePdpResponse } from "./validate.js";

export const GOVERNED_ACTION_PROTOCOL_VERSION = "1.0.0" as const;

export interface DelegationLink {
  principalId: string;
  delegateId: string;
  scopes: string[];
  expiresAt: string;
}

export interface GovernedActionEnvelope {
  protocolVersion: string;
  id: string;
  tenantId: string;
  idempotencyKey: string;
  requestedAt: string;
  request: PdpRequest;
  delegationChain?: DelegationLink[];
}

export interface GovernedExecutionReceipt {
  protocolVersion: string;
  actionId: string;
  authorizationRecordId: string;
  authorizationContentHash: string;
  executorId: string;
  state: "dry_run" | "executed" | "verified" | "compensated";
  externalId: string | null;
  outputDigest: string | null;
  occurredAt: string;
}

export interface GovernedActionExchange {
  envelope: GovernedActionEnvelope;
  verdict: PdpResponse;
  receipt?: GovernedExecutionReceipt;
}

export interface ProtocolValidation {
  valid: boolean;
  errors: string[];
}

const hex64 = /^[0-9a-f]{64}$/;

export function validateGovernedActionExchange(
  exchange: GovernedActionExchange,
): ProtocolValidation {
  const errors: string[] = [];
  const { envelope, verdict, receipt } = exchange;
  if (envelope.protocolVersion !== GOVERNED_ACTION_PROTOCOL_VERSION)
    errors.push("unsupported governed-action protocol version");
  if (!envelope.id || !envelope.tenantId || !envelope.idempotencyKey)
    errors.push("action identity, tenant, and idempotency key are required");
  if (!Number.isFinite(Date.parse(envelope.requestedAt)))
    errors.push("requestedAt must be an ISO timestamp");
  const verdictValidation = validatePdpResponse(verdict);
  errors.push(...verdictValidation.errors.map((error) => `verdict: ${error}`));

  for (const [index, link] of (envelope.delegationChain ?? []).entries()) {
    if (!link.principalId || !link.delegateId || link.scopes.length === 0)
      errors.push(`delegation ${index} is incomplete`);
    if (Date.parse(link.expiresAt) <= Date.parse(envelope.requestedAt))
      errors.push(`delegation ${index} is expired`);
    const next = envelope.delegationChain?.[index + 1];
    if (next && link.delegateId !== next.principalId)
      errors.push(`delegation ${index} does not connect to delegation ${index + 1}`);
    if (!link.scopes.includes("*") && !link.scopes.includes(envelope.request.action.type))
      errors.push(`delegation ${index} does not authorize ${envelope.request.action.type}`);
  }
  const finalDelegation = envelope.delegationChain?.at(-1);
  if (finalDelegation && finalDelegation.delegateId !== envelope.request.action.agentId)
    errors.push("delegation chain does not terminate at the acting agent");

  if (receipt) {
    if (receipt.protocolVersion !== GOVERNED_ACTION_PROTOCOL_VERSION)
      errors.push("receipt protocol version mismatch");
    if (receipt.actionId !== envelope.id)
      errors.push("receipt is not bound to the action envelope");
    if (!hex64.test(receipt.authorizationContentHash))
      errors.push("receipt authorization hash must be a lowercase SHA-256 digest");
    if (receipt.outputDigest !== null && !hex64.test(receipt.outputDigest))
      errors.push("receipt output digest must be a lowercase SHA-256 digest or null");
    if (Date.parse(receipt.occurredAt) < Date.parse(envelope.requestedAt))
      errors.push("receipt cannot precede the action request");
    if (!verdict.evidenceBinding) errors.push("executed actions require an evidence-bound verdict");
    if (
      verdict.evidenceBinding &&
      receipt.authorizationContentHash !== verdict.evidenceBinding.contentHash
    ) {
      errors.push("receipt authorization hash does not match the verdict evidence binding");
    }
    if (verdict.decision === "block" || verdict.decision === "escalate")
      errors.push(`a ${verdict.decision} verdict cannot have an execution receipt`);
  }
  return { valid: errors.length === 0, errors };
}

export interface GovernedActionConformanceResult {
  protocolVersion: string;
  passed: boolean;
  cases: Array<{ id: string; passed: boolean; detail: string }>;
}

export function runGovernedActionConformance(
  exchange: GovernedActionExchange,
): GovernedActionConformanceResult {
  const result = validateGovernedActionExchange(exchange);
  const groups = [
    [
      "envelope",
      result.errors.filter(
        (error) =>
          error.includes("action") || error.includes("delegation") || error.includes("requestedAt"),
      ),
    ],
    ["verdict", result.errors.filter((error) => error.startsWith("verdict:"))],
    [
      "effect-binding",
      result.errors.filter((error) => error.includes("receipt") || error.includes("execution")),
    ],
  ] as const;
  const cases = groups.map(([id, errors]) => ({
    id,
    passed: errors.length === 0,
    detail: errors.length ? errors.join("; ") : `${id} conforms`,
  }));
  return { protocolVersion: GOVERNED_ACTION_PROTOCOL_VERSION, passed: result.valid, cases };
}
