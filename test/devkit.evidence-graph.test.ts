import { describe, expect, it } from "vitest";
import { diffPolicies, runDoctor, sanitizeFixture, simulatePolicy } from "@pharos/devkit";
import { EvidenceGraph } from "@pharos/observability";
import type { PolicyArtifact } from "@pharos/policy";
import type { VerdictRequest } from "@pharos/core";

const request: VerdictRequest = {
  tenantId: "acme",
  action: {
    type: "payment.transfer",
    agentId: "agent",
    payload: {},
    emittedAt: "2026-08-30T00:00:00.000Z",
  },
  liability: {
    mandate: null,
    oversightMode: "autonomous",
    blastRadius: { financialAmount: 30_000, currency: "USD", reversibility: "irreversible" },
    modelMetadata: null,
  },
};

const allow: PolicyArtifact = { packId: "base", version: "1", title: "base", rules: [] };
const candidate: PolicyArtifact = {
  packId: "candidate",
  version: "1",
  title: "candidate",
  rules: [
    {
      ruleId: "large-transfer",
      pack: "candidate",
      description: "review large transfer",
      when: { field: "liability.blastRadius.financialAmount", op: "gte", value: 25_000 },
      decision: "escalate",
    },
  ],
};

describe("developer workbench", () => {
  it("simulates and reports exact policy transitions", () => {
    const cases = [{ id: "wire", request, expected: "escalate" as const }];
    expect(simulatePolicy(candidate, cases)[0]).toMatchObject({
      decision: "escalate",
      passed: true,
    });
    expect(diffPolicies(allow, candidate, cases)).toMatchObject({
      total: 1,
      changed: 1,
      transitions: { "allow->escalate": 1 },
    });
  });

  it("sanitizes credentials and diagnoses configuration", () => {
    expect(sanitizeFixture({ token: "secret", nested: { password: "secret", ok: 1 } })).toEqual({
      nested: { ok: 1, password: "[REDACTED]" },
      token: "[REDACTED]",
    });
    expect(
      runDoctor({ nodeVersion: "v22.1.0", pharosUrl: "http://localhost:4000", apiKey: "x" }).every(
        (c) => c.passed,
      ),
    ).toBe(true);
  });
});

describe("causal evidence graph", () => {
  it("exports GenAI-compatible spans and rejects cross-tenant edges", () => {
    const graph = new EvidenceGraph();
    graph.addNode({
      id: "model",
      tenantId: "acme",
      kind: "model_call",
      at: "2026-08-30T00:00:00.000Z",
      attributes: {},
    });
    graph.addNode({
      id: "tool",
      tenantId: "acme",
      kind: "tool_call",
      at: "2026-08-30T00:00:01.000Z",
      attributes: { "tool.name": "wire" },
    });
    graph.addEdge({ from: "model", to: "tool", relationship: "caused" });
    expect(graph.causalChain("tool").map((node) => node.id)).toEqual(["model", "tool"]);
    expect(graph.toOpenTelemetry("a".repeat(32))[1]?.attributes["gen_ai.tool.name"]).toBe("wire");
    graph.addNode({
      id: "other",
      tenantId: "other",
      kind: "verification",
      at: "2026-08-30T00:00:02.000Z",
      attributes: {},
    });
    expect(() => graph.addEdge({ from: "tool", to: "other", relationship: "verified" })).toThrow(
      "cross-tenant",
    );
  });
});
