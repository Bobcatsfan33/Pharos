import { describe, expect, it } from "vitest";
import { LocalKms, sha256Hex, type VerdictContext } from "@pharos/core";
import {
  importOpaPolicy,
  signPolicyBundle,
  verifyPolicyBundle,
  evaluateArtifact,
} from "@pharos/policy";
import {
  McpToolRegistry,
  createHttpConnector,
  executeGovernedEffect,
  issueMcpCredential,
  runPluginConformance,
  toMcpVerdictRequest,
} from "@pharos/connectors";
import {
  resolveApprovalRequirement,
  evaluateApprovals,
  type ApprovalPolicyRule,
} from "@pharos/review";
import { simulatePolicy } from "@pharos/devkit";
import { EvidenceGraph } from "@pharos/observability";
import { AssuranceLab, registerDataset } from "@pharos/judge-eval";
import { evaluateControlPack, PHAROS_CONTROL_PACK } from "@pharos/assurance";
import { validateEnterpriseDeployment } from "@pharos/config";
import {
  GOVERNED_ACTION_PROTOCOL_VERSION,
  runGovernedActionConformance,
  type GovernedActionExchange,
} from "@getpharos/pdp-spec";
import { MemoryKeystore } from "./support/memoryKeystore.js";

const at = "2026-08-30T12:00:00.000Z";

describe("Pharos capability breadth", () => {
  it("governs an MCP tool from portable policy through verified external effect and assurance", async () => {
    // 1. Import and sign a portable policy bundle.
    const imported = importOpaPolicy({
      package: "treasury",
      revision: "git:abc123",
      rules: [
        {
          name: "wire-ceiling",
          effect: "block",
          description: "Block wires above the mandate ceiling",
          when: { path: "liability.blastRadius.financialAmount", operator: "gt", value: 25_000 },
        },
      ],
    });
    const kms = new LocalKms(new MemoryKeystore());
    const bundle = await signPolicyBundle(imported, kms, "policy:acme", at);
    expect(await verifyPolicyBundle(bundle, kms)).toBe(true);

    // 2. Register the MCP schema and normalize the tool call into the universal action contract.
    const tools = new McpToolRegistry();
    const tool = tools.register({
      serverUrl: "https://mcp.bank.example",
      name: "wire_funds",
      inputSchema: { type: "object", required: ["amount", "beneficiary"] },
      risk: {
        reversibility: "irreversible",
        financialAmount: 20_000,
        currency: "USD",
        dataClasses: ["financial"],
      },
      requiredScopes: ["payments:write"],
    }).tool;
    const request = toMcpVerdictRequest(
      {
        tenantId: "acme",
        agentId: "treasury-agent",
        sessionId: "run-1",
        subject: "operator",
        serverUrl: tool.serverUrl,
        toolName: tool.name,
        arguments: { amount: 20_000, beneficiary: "vendor" },
      },
      tool,
      "human_in_loop",
    );
    expect(evaluateArtifact(bundle.artifact, { request, judgeProbabilities: {} })).toEqual([]);
    expect(
      simulatePolicy(bundle.artifact, [{ id: "wire", request, expected: "allow" }])[0]!.passed,
    ).toBe(true);

    // 3. Enforce a two-person, cross-role review before issuing a fresh tool credential.
    const approvalRules: ApprovalPolicyRule[] = [
      {
        id: "wire-review",
        priority: 10,
        actionTypes: ["mcp.wire_funds"],
        minimumAmount: 10_000,
        requirement: {
          minimumApprovals: 2,
          requiredRoles: ["risk", "finance"],
          separationOfDuties: true,
          expiresInSeconds: 900,
        },
      },
    ];
    const reviewContext = {
      tenantId: "acme",
      actionType: request.action.type,
      riskScore: 0.6,
      amount: request.liability.blastRadius.financialAmount,
      irreversible: true,
      actorId: "operator",
    };
    const requirement = resolveApprovalRequirement(reviewContext, approvalRules, at)!;
    const approval = evaluateApprovals(
      reviewContext,
      requirement,
      [
        {
          subjectId: "alice",
          roles: ["risk"],
          decision: "approve",
          at: "2026-08-30T12:01:00.000Z",
        },
        {
          subjectId: "bob",
          roles: ["finance"],
          decision: "approve",
          at: "2026-08-30T12:02:00.000Z",
        },
      ],
      { now: "2026-08-30T12:03:00.000Z" },
    );
    expect(approval.status).toBe("approved");
    const authorizationHash = sha256Hex({ request, approval, policy: bundle.artifactDigest });
    const credential = await issueMcpCredential({
      tool,
      subject: "treasury-agent",
      authorizationRecordId: "record-1",
      approvedScopes: ["payments:write"],
      issuer: { issue: async () => "fresh-tool-token" },
      now: () => Date.parse(at),
    });
    expect(credential.token).toBe("fresh-tool-token");

    // 4. Execute through a conforming connector and capture a verified receipt.
    const connector = createHttpConnector(async () => ({
      status: 200,
      body: { id: "wire-9000", status: "accepted" },
    }));
    const effectRequest = {
      tenantId: "acme",
      connectorId: "http",
      operation: "create",
      input: { url: "https://bank.example/wires", body: { amount: 20_000 }, reversible: false },
      idempotencyKey: "wire-once",
      authorizationRecordId: "record-1",
    };
    expect(
      (
        await runPluginConformance(
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
          effectRequest,
        )
      ).passed,
    ).toBe(true);
    const verdict: VerdictContext = {
      decision: "allow",
      tierReached: "human",
      ruleCitations: [],
      riskScore: 0.6,
      failMode: null,
      judgeVersion: null,
      latency: { totalMs: 30, perTier: { human: 25 }, deadlineMs: 800, deadlineBreached: false },
    };
    const effect = await executeGovernedEffect({
      connector,
      request: effectRequest,
      verdict,
      now: () => "2026-08-30T12:04:00.000Z",
    });
    expect(effect.receipt.state).toBe("verified");

    // 5. Preserve the causal chain and emit parent-linked GenAI/OpenTelemetry spans.
    const graph = new EvidenceGraph();
    graph.addNode({
      id: "tool",
      tenantId: "acme",
      kind: "tool_call",
      at,
      attributes: { "tool.name": tool.name },
    });
    graph.addNode({
      id: "review",
      tenantId: "acme",
      kind: "human_review",
      at: "2026-08-30T12:03:00.000Z",
      attributes: { quorum: 2 },
    });
    graph.addNode({
      id: "effect",
      tenantId: "acme",
      kind: "external_effect",
      at: effect.receipt.occurredAt,
      attributes: { externalId: effect.receipt.externalId },
    });
    graph.addEdge({ from: "tool", to: "review", relationship: "reviewed" });
    graph.addEdge({ from: "review", to: "effect", relationship: "executed" });
    expect(graph.causalChain("effect").map((node) => node.id)).toEqual([
      "tool",
      "review",
      "effect",
    ]);
    expect(graph.toOpenTelemetry("trace-1")[1]!.parentSpanId).toBeDefined();

    // 6. Gate the deployed model, map controls honestly, and validate the operating plane.
    const dataset = registerDataset({
      id: "treasury-eval",
      version: "1",
      slices: ["wires"],
      recordCount: 100,
      provenance: {
        source: "synthetic",
        collectedAt: at,
        license: "CC0-1.0",
        containsPersonalData: false,
      },
    });
    const lab = new AssuranceLab("judge-v1");
    expect(
      lab.evaluate({
        candidateId: "judge-v2",
        dataset,
        gate: { pass: true, operatingPointsHash: "op", baselineHash: "base", verdicts: [] },
      }).status,
    ).toBe("promote");
    const controls = evaluateControlPack(
      PHAROS_CONTROL_PACK,
      { "evidence.chain_verified": true, "records.retained": true },
      ["EU-AI-ACT"],
    );
    expect(controls.coverage).toBe(1);
    expect(
      validateEnterpriseDeployment({
        regions: [
          { id: "us-east", jurisdiction: "US", replicas: 3 },
          { id: "us-west", jurisdiction: "US", replicas: 3 },
        ],
        tenants: [
          {
            tenantId: "acme",
            allowedJurisdictions: ["US"],
            primaryRegion: "us-east",
            replicaRegions: ["us-west"],
          },
        ],
        kms: { provider: "aws-kms", customerManaged: true, privateEndpoint: true },
        identity: { sso: true, scim: true },
        recovery: { rpoMinutes: 5, rtoMinutes: 30 },
      }).valid,
    ).toBe(true);

    // 7. Export the complete exchange through the open governed-action protocol.
    const exchange: GovernedActionExchange = {
      envelope: {
        protocolVersion: GOVERNED_ACTION_PROTOCOL_VERSION,
        id: "action-1",
        tenantId: "acme",
        idempotencyKey: "wire-once",
        requestedAt: at,
        request: {
          action: {
            type: request.action.type,
            agentId: request.action.agentId,
            payload: request.action.payload,
          },
          liability: {
            mandate: null,
            oversightMode: request.liability.oversightMode,
            blastRadius: request.liability.blastRadius,
          },
        },
      },
      verdict: {
        specVersion: "1.0.0",
        decision: "allow",
        tierReached: "human",
        riskScore: 0.6,
        ruleCitations: [],
        failMode: null,
        judgeVersion: null,
        latency: { totalMs: 30, deadlineMs: 800, deadlineBreached: false },
        evidenceBinding: {
          algorithm: "ed25519",
          contentHash: authorizationHash,
          keyId: bundle.keyId,
          signature: bundle.signature,
        },
      },
      receipt: {
        protocolVersion: GOVERNED_ACTION_PROTOCOL_VERSION,
        actionId: "action-1",
        authorizationRecordId: "record-1",
        authorizationContentHash: authorizationHash,
        executorId: "connector:http",
        state: "verified",
        externalId: effect.receipt.externalId,
        outputDigest: effect.receipt.outputDigest,
        occurredAt: effect.receipt.occurredAt,
      },
    };
    expect(runGovernedActionConformance(exchange).passed).toBe(true);
  });
});
