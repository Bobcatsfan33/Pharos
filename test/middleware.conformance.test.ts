import { describe, it, expect } from "vitest";
import {
  langchainTool,
  langgraphNode,
  openaiAgentTool,
  anthropicToolHandlers,
  PharosBlockedError,
  type Governor,
} from "@pharos/middleware";
import type { ClaimResult, Escalation, SubmitInput, SubmitResult } from "@pharos/sdk";

/**
 * One conformance contract, exercised through every framework adapter. A governed tool must:
 *   allow            → run the tool, return its result
 *   block            → throw PharosBlockedError, never run the tool
 *   escalate+approve → run the tool exactly once after the human verdict
 *   escalate+reject  → throw, never run the tool
 *   double-resume    → run the tool at most once (exactly-once)
 */
class FakeGovernor implements Governor {
  private claimed = new Set<string>();
  constructor(
    private readonly decision: SubmitResult["verdict"]["decision"],
    private readonly resolutionStatus: Escalation["status"] = "approved",
  ) {}

  async submit(_input: SubmitInput): Promise<SubmitResult> {
    const verdict: SubmitResult["verdict"] = {
      decision: this.decision,
      tierReached: 1,
      riskScore: 0,
      ruleCitations: [{ ruleId: "test", pack: "test" }],
      failMode: null,
      judgeVersion: null,
      latency: { totalMs: 1, perTier: {}, deadlineMs: 800, deadlineBreached: false },
    };
    return {
      verdict,
      record: { content: { id: "r1", sequence: 0 } },
      escalation: this.decision === "escalate" ? { id: "e1", status: "pending" } : null,
    };
  }

  async awaitResolution(_t: string, id: string): Promise<Escalation> {
    return { id, status: this.resolutionStatus, resolution: { decision: "approve", rationale: "ok", modifiedAction: null } };
  }

  async claim(_t: string, id: string): Promise<ClaimResult> {
    const first = !this.claimed.has(id);
    this.claimed.add(id);
    return {
      claimed: first,
      status: this.resolutionStatus,
      resolution: { decision: "approve", rationale: "ok", modifiedAction: null },
      escalation: { id, status: this.resolutionStatus, resolution: null },
    };
  }
}

type GovernedInvoke = (args: Record<string, unknown>) => Promise<unknown>;

const FRAMEWORKS: Array<{
  name: string;
  make: (gov: Governor, tool: (a: Record<string, unknown>) => unknown) => GovernedInvoke;
}> = [
  {
    name: "langchain/langgraph (tool)",
    make: (gov, tool) => langchainTool(gov, { tenantId: "t", agentId: "a", toolName: "pay" }, tool).invoke,
  },
  {
    name: "openai-agents",
    make: (gov, tool) => openaiAgentTool(gov, { tenantId: "t", agentId: "a", toolName: "pay" }, tool).execute,
  },
  {
    name: "anthropic (tool_use)",
    make: (gov, tool) => anthropicToolHandlers(gov, { tenantId: "t", agentId: "a" }, { pay: tool }).pay,
  },
  {
    name: "langgraph (node)",
    make: (gov, tool) => {
      const node = langgraphNode<Record<string, unknown>, unknown>(
        gov,
        { tenantId: "t", agentId: "a", toolName: "pay" },
        tool,
        (_s, r) => ({ result: r }),
      );
      return async (args) => (await node(args)).result;
    },
  },
];

for (const fw of FRAMEWORKS) {
  describe(`middleware conformance — ${fw.name}`, () => {
    it("allow → runs the tool and returns its result", async () => {
      let runs = 0;
      const invoke = fw.make(new FakeGovernor("allow"), () => {
        runs++;
        return "done";
      });
      await expect(invoke({ amount: 1 })).resolves.toBe("done");
      expect(runs).toBe(1);
    });

    it("block → throws and never runs the tool", async () => {
      let runs = 0;
      const invoke = fw.make(new FakeGovernor("block"), () => {
        runs++;
        return "done";
      });
      await expect(invoke({ amount: 1 })).rejects.toBeInstanceOf(PharosBlockedError);
      expect(runs).toBe(0);
    });

    it("escalate + approve → runs the tool exactly once", async () => {
      let runs = 0;
      const invoke = fw.make(new FakeGovernor("escalate", "approved"), () => {
        runs++;
        return "done";
      });
      await expect(invoke({ amount: 1 })).resolves.toBe("done");
      expect(runs).toBe(1);
    });

    it("escalate + reject → throws and never runs the tool", async () => {
      let runs = 0;
      const invoke = fw.make(new FakeGovernor("escalate", "rejected"), () => {
        runs++;
        return "done";
      });
      await expect(invoke({ amount: 1 })).rejects.toBeInstanceOf(PharosBlockedError);
      expect(runs).toBe(0);
    });

    it("double-resume of one escalation runs the tool at most once (exactly-once)", async () => {
      let runs = 0;
      const gov = new FakeGovernor("escalate", "approved");
      const invoke = fw.make(gov, () => {
        runs++;
        return "done";
      });
      // Two concurrent governed invocations sharing the same escalation id.
      const results = await Promise.allSettled([invoke({ amount: 1 }), invoke({ amount: 1 })]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(runs).toBe(1);
      expect(fulfilled.length).toBe(1);
    });
  });
}
