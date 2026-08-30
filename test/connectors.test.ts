import { describe, expect, it } from "vitest";
import {
  EffectRegistry,
  McpToolRegistry,
  createHttpConnector,
  executeGovernedEffect,
  issueMcpCredential,
  runPluginConformance,
  toMcpVerdictRequest,
  type EffectRequest,
} from "@pharos/connectors";
import type { VerdictContext } from "@pharos/core";

const allow: VerdictContext = {
  decision: "allow",
  tierReached: 1,
  ruleCitations: [],
  riskScore: 0,
  failMode: null,
  judgeVersion: null,
  latency: { totalMs: 1, perTier: { "1": 1 }, deadlineMs: 800, deadlineBreached: false },
};

describe("MCP governance", () => {
  it("detects schema drift and builds a liability-bound action", async () => {
    const registry = new McpToolRegistry();
    const first = registry.register({
      serverUrl: "https://mcp.example.com",
      name: "wire_funds",
      inputSchema: { type: "object", required: ["amount"] },
      risk: { reversibility: "irreversible", financialAmount: 30_000 },
      requiredScopes: ["payments:write"],
    });
    const second = registry.register({
      ...first.tool,
      inputSchema: { type: "object", required: ["amount", "beneficiary"] },
    });
    expect(second.drifted).toBe(true);
    expect(second.tool.version).toBe(2);

    const request = toMcpVerdictRequest(
      {
        tenantId: "acme",
        agentId: "treasury-agent",
        subject: "alice",
        serverUrl: second.tool.serverUrl,
        toolName: second.tool.name,
        arguments: { amount: 30_000, beneficiary: "vendor" },
      },
      second.tool,
      "human_in_loop",
    );
    expect(request.action.type).toBe("mcp.wire_funds");
    expect(request.liability.blastRadius.financialAmount).toBe(30_000);

    const credential = await issueMcpCredential({
      tool: second.tool,
      subject: "alice",
      authorizationRecordId: "rec-1",
      approvedScopes: ["payments:write", "unused"],
      issuer: { issue: async ({ audience }) => `fresh:${audience}` },
      now: () => 0,
    });
    expect(credential.audience).toBe("https://mcp.example.com");
    expect(credential.token).toBe("fresh:https://mcp.example.com");
    expect(credential.scopes).toEqual(["payments:write"]);
  });
});

describe("governed effects and plugins", () => {
  const request: EffectRequest = {
    tenantId: "acme",
    connectorId: "http",
    operation: "create",
    input: { url: "https://api.example.com/transfer", body: { amount: 10 }, reversible: true },
    idempotencyKey: "effect-1",
    authorizationRecordId: "record-1",
  };

  it("produces a verified, digest-bound receipt and forwards idempotency", async () => {
    let key = "";
    const connector = createHttpConnector(async ({ headers }) => {
      key = headers["Idempotency-Key"] ?? "";
      return { status: 200, body: { id: "external-1", ok: true } };
    });
    const result = await executeGovernedEffect({
      connector,
      request,
      verdict: allow,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    expect(key).toBe("effect-1");
    expect(result.receipt.state).toBe("verified");
    expect(result.receipt.planDigest).toMatch(/^[0-9a-f]{64}$/);

    const conformance = await runPluginConformance(
      {
        manifest: {
          schemaVersion: "pharos.connector-plugin.v1",
          id: "http",
          version: "1.0.0",
          displayName: "HTTP",
          permissions: ["network:outbound", "effect:execute"],
          operations: ["create"],
        },
        connector,
      },
      request,
    );
    expect(conformance.passed).toBe(true);
    const registry = new EffectRegistry();
    registry.register(connector);
    expect(registry.list()).toEqual(["http"]);
  });

  it("refuses execution under an escalation", async () => {
    const connector = createHttpConnector(async () => ({ status: 200, body: { id: "never" } }));
    await expect(
      executeGovernedEffect({ connector, request, verdict: { ...allow, decision: "escalate" } }),
    ).rejects.toThrow("not executable");
  });
});
