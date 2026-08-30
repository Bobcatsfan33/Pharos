import { sha256Hex } from "@pharos/core";
import type { EffectConnector, EffectPlan, EffectRequest, EffectResult } from "./effects.js";

export interface HttpTransportResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export type HttpTransport = (request: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}) => Promise<HttpTransportResponse>;

/** Generic durable HTTP connector. The target must echo its external id and replay status. */
export function createHttpConnector(transport: HttpTransport): EffectConnector {
  return {
    id: "http",
    plan(request) {
      const url = request.input.url;
      if (typeof url !== "string" || !/^https?:\/\//.test(url))
        throw new Error("HTTP effect requires url");
      return {
        connectorId: "http",
        operation: request.operation,
        inputDigest: sha256Hex(request.input),
        reversible: request.input.reversible === true,
        requiredScopes: [],
        estimatedImpact: { target: new URL(url).origin },
      };
    },
    async dryRun(plan) {
      return { valid: true, target: plan.estimatedImpact?.target, inputDigest: plan.inputDigest };
    },
    async execute(_plan: EffectPlan, request: EffectRequest): Promise<EffectResult> {
      const response = await transport({
        method: typeof request.input.method === "string" ? request.input.method : "POST",
        url: String(request.input.url),
        headers: { "Idempotency-Key": request.idempotencyKey },
        body: (request.input.body as Record<string, unknown> | undefined) ?? {},
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error(`HTTP effect failed: ${response.status}`);
      const externalId = response.body.id;
      if (typeof externalId !== "string" || !externalId)
        throw new Error("HTTP effect response requires id");
      return {
        externalId,
        output: response.body,
        replayed: response.headers?.["x-idempotency-replayed"] === "true",
      };
    },
    async verify(_plan, result) {
      return result.externalId.length > 0;
    },
  };
}
