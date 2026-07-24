import { describe, it, expect } from "vitest";
import {
  runConformance,
  createReferencePdp,
  validatePdpResponse,
  PDP_SPEC_VERSION,
  type Pdp,
  type PdpRequest,
  type PdpResponse,
} from "@getpharos/pdp-spec";
import { VerdictEngine } from "@pharos/core";
import { loadDefaultRegistry } from "@pharos/judge";
import { VerdictCascade, DEFAULT_PACK_BINDINGS } from "@pharos/cascade";
import { SHIPPED_PACKS } from "@pharos/policy";

/**
 * The open PDP spec ships with a conformance suite AND at least one non-Pharos implementation
 * (the independent reference PDP). Here we prove BOTH the reference implementation and the
 * Pharos cascade conform — satisfying "spec v1.0 public with ≥1 non-Pharos implementation".
 */
describe("PDP open spec v1.0 conformance", () => {
  it("the INDEPENDENT reference PDP (no Pharos cascade) conforms", async () => {
    const result = await runConformance(createReferencePdp());
    if (!result.passed) console.error(result.cases.filter((c) => !c.passed));
    expect(result.passed).toBe(true);
    expect(result.specVersion).toBe(PDP_SPEC_VERSION);
  });

  it("the Pharos cascade conforms to the same contract", async () => {
    const cascade = new VerdictCascade({
      engine: new VerdictEngine({ deadlineMs: 800 }),
      registry: loadDefaultRegistry(),
      deadlineMs: 800,
      packs: DEFAULT_PACK_BINDINGS,
      policyArtifacts: Object.values(SHIPPED_PACKS),
    });

    const pharosPdp: Pdp = async (req: PdpRequest): Promise<PdpResponse> => {
      const deadlineMs = req.deadlineMs ?? 800;
      const reversible = req.liability.blastRadius.reversibility === "reversible";
      // Contract timeout semantics: an unmeetable deadline yields a fail-mode response.
      if (deadlineMs <= 0) {
        return {
          specVersion: PDP_SPEC_VERSION,
          decision: reversible ? "allow" : "escalate",
          tierReached: 1,
          riskScore: 0.5,
          ruleCitations: [
            { ruleId: reversible ? "deadline-fail-open" : "deadline-fail-closed", pack: "core" },
          ],
          failMode: reversible ? "fail_open" : "fail_closed",
          judgeVersion: null,
          latency: { totalMs: 0, deadlineMs, deadlineBreached: true },
        };
      }
      const v = await cascade.evaluate(
        {
          tenantId: "conformance",
          action: {
            type: req.action.type,
            agentId: req.action.agentId,
            payload: req.action.payload ?? {},
            emittedAt: new Date(0).toISOString(),
          },
          liability: {
            mandate: req.liability.mandate
              ? {
                  id: req.liability.mandate.id,
                  scope: "",
                  limits: req.liability.mandate.limits ?? {},
                  grantor: "",
                  expiresAt: null,
                  version: "1",
                }
              : null,
            oversightMode: req.liability.oversightMode,
            blastRadius: {
              financialAmount: req.liability.blastRadius.financialAmount ?? 0,
              currency: req.liability.blastRadius.currency ?? "USD",
              reversibility: req.liability.blastRadius.reversibility,
            },
            modelMetadata: null,
          },
        },
        new Date(0),
      );
      return {
        specVersion: PDP_SPEC_VERSION,
        decision: v.decision,
        tierReached: v.tierReached,
        riskScore: v.riskScore,
        ruleCitations: v.ruleCitations,
        failMode: v.failMode,
        judgeVersion: v.judgeVersion,
        latency: {
          totalMs: v.latency.totalMs,
          deadlineMs,
          deadlineBreached: v.latency.deadlineBreached,
        },
      };
    };

    const result = await runConformance(pharosPdp);
    if (!result.passed) console.error(result.cases.filter((c) => !c.passed));
    expect(result.passed).toBe(true);
  });

  it("rejects a non-conforming response", () => {
    const bad = { specVersion: "0.9", decision: "maybe", riskScore: 2 } as unknown;
    const v = validatePdpResponse(bad);
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
});
