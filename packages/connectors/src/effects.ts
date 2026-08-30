import { sha256Hex, type VerdictContext } from "@pharos/core";

export type EffectState = "planned" | "dry_run" | "executed" | "verified" | "compensated";

export interface EffectRequest {
  tenantId: string;
  connectorId: string;
  operation: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
  authorizationRecordId: string;
}

export interface EffectPlan {
  connectorId: string;
  operation: string;
  inputDigest: string;
  reversible: boolean;
  requiredScopes: string[];
  estimatedImpact?: Record<string, unknown>;
}

export interface EffectResult {
  externalId: string;
  output?: Record<string, unknown>;
  replayed?: boolean;
}

export interface EffectReceipt {
  schemaVersion: "pharos.effect-receipt.v1";
  tenantId: string;
  connectorId: string;
  operation: string;
  idempotencyKey: string;
  authorizationRecordId: string;
  planDigest: string;
  state: EffectState;
  externalId: string | null;
  outputDigest: string | null;
  verified: boolean;
  replayed: boolean;
  occurredAt: string;
}

export interface EffectConnector {
  readonly id: string;
  plan(request: EffectRequest): Promise<EffectPlan> | EffectPlan;
  dryRun(plan: EffectPlan, request: EffectRequest): Promise<Record<string, unknown>>;
  execute(plan: EffectPlan, request: EffectRequest): Promise<EffectResult>;
  verify(plan: EffectPlan, result: EffectResult, request: EffectRequest): Promise<boolean>;
  compensate?(
    plan: EffectPlan,
    result: EffectResult,
    request: EffectRequest,
  ): Promise<EffectResult>;
}

export class EffectRegistry {
  private readonly connectors = new Map<string, EffectConnector>();

  register(connector: EffectConnector): void {
    if (this.connectors.has(connector.id))
      throw new Error(`connector already registered: ${connector.id}`);
    this.connectors.set(connector.id, connector);
  }

  get(id: string): EffectConnector {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`unknown connector: ${id}`);
    return connector;
  }

  list(): string[] {
    return [...this.connectors.keys()].sort();
  }
}

function assertAuthorized(verdict: VerdictContext): void {
  if (verdict.decision === "block" || verdict.decision === "escalate") {
    throw new Error(`effect is not executable under ${verdict.decision} verdict`);
  }
}

export async function executeGovernedEffect(options: {
  connector: EffectConnector;
  request: EffectRequest;
  verdict: VerdictContext;
  dryRun?: boolean;
  now?: () => string;
}): Promise<{ plan: EffectPlan; receipt: EffectReceipt; preview?: Record<string, unknown> }> {
  assertAuthorized(options.verdict);
  if (options.connector.id !== options.request.connectorId) {
    throw new Error("connector identity does not match effect request");
  }
  const plan = await options.connector.plan(options.request);
  const planDigest = sha256Hex(plan);
  const occurredAt = (options.now ?? (() => new Date().toISOString()))();
  if (options.dryRun) {
    const preview = await options.connector.dryRun(plan, options.request);
    return {
      plan,
      preview,
      receipt: {
        schemaVersion: "pharos.effect-receipt.v1",
        tenantId: options.request.tenantId,
        connectorId: options.request.connectorId,
        operation: options.request.operation,
        idempotencyKey: options.request.idempotencyKey,
        authorizationRecordId: options.request.authorizationRecordId,
        planDigest,
        state: "dry_run",
        externalId: null,
        outputDigest: sha256Hex(preview),
        verified: false,
        replayed: false,
        occurredAt,
      },
    };
  }
  const result = await options.connector.execute(plan, options.request);
  const verified = await options.connector.verify(plan, result, options.request);
  return {
    plan,
    receipt: {
      schemaVersion: "pharos.effect-receipt.v1",
      tenantId: options.request.tenantId,
      connectorId: options.request.connectorId,
      operation: options.request.operation,
      idempotencyKey: options.request.idempotencyKey,
      authorizationRecordId: options.request.authorizationRecordId,
      planDigest,
      state: verified ? "verified" : "executed",
      externalId: result.externalId,
      outputDigest: result.output ? sha256Hex(result.output) : null,
      verified,
      replayed: result.replayed ?? false,
      occurredAt,
    },
  };
}

export async function compensateGovernedEffect(options: {
  connector: EffectConnector;
  request: EffectRequest;
  plan: EffectPlan;
  result: EffectResult;
  now?: () => string;
}): Promise<EffectReceipt> {
  if (!options.plan.reversible || !options.connector.compensate) {
    throw new Error(`connector ${options.connector.id} cannot compensate this effect`);
  }
  const compensated = await options.connector.compensate(
    options.plan,
    options.result,
    options.request,
  );
  return {
    schemaVersion: "pharos.effect-receipt.v1",
    tenantId: options.request.tenantId,
    connectorId: options.request.connectorId,
    operation: options.request.operation,
    idempotencyKey: options.request.idempotencyKey,
    authorizationRecordId: options.request.authorizationRecordId,
    planDigest: sha256Hex(options.plan),
    state: "compensated",
    externalId: compensated.externalId,
    outputDigest: compensated.output ? sha256Hex(compensated.output) : null,
    verified: true,
    replayed: compensated.replayed ?? false,
    occurredAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}
