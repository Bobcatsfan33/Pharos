import { PDP_SPEC_VERSION, type Pdp, type PdpRequest } from "./contract.js";
import { validatePdpResponse } from "./validate.js";

/**
 * The PDP conformance suite. Any implementation of the open contract can self-certify by
 * passing these cases — they test contract compliance and the timeout/fail-mode semantics,
 * not any specific policy. A non-Pharos PDP that passes is a conforming implementation.
 */
export interface ConformanceCase {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ConformanceResult {
  specVersion: string;
  passed: boolean;
  cases: ConformanceCase[];
}

function benign(over: Partial<PdpRequest> = {}): PdpRequest {
  return {
    action: { type: "email.send", agentId: "a", payload: { body: "hello" } },
    liability: {
      mandate: null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
    },
    ...over,
  };
}

export async function runConformance(pdp: Pdp): Promise<ConformanceResult> {
  const cases: ConformanceCase[] = [];
  const add = (id: string, passed: boolean, detail: string) => cases.push({ id, passed, detail });

  // C1: schema validity + spec version.
  const r1 = await pdp(benign());
  const v1 = validatePdpResponse(r1);
  add(
    "schema-valid",
    v1.valid,
    v1.valid ? "response conforms to the schema" : v1.errors.join("; "),
  );
  add("spec-version", r1.specVersion === PDP_SPEC_VERSION, `specVersion=${r1.specVersion}`);

  // C2: decision/risk ranges (covered by schema, asserted explicitly).
  add(
    "decision-enum",
    ["allow", "block", "modify", "escalate"].includes(r1.decision),
    `decision=${r1.decision}`,
  );
  add("risk-range", r1.riskScore >= 0 && r1.riskScore <= 1, `riskScore=${r1.riskScore}`);

  // C3: the deadline is echoed in latency accounting.
  const r3 = await pdp(benign({ deadlineMs: 500 }));
  add(
    "deadline-echo",
    r3.latency.deadlineMs === 500,
    `latency.deadlineMs=${r3.latency.deadlineMs}`,
  );

  // C4: an unmeetable deadline yields a fail-mode response consistent with reversibility.
  const rOpen = await pdp(
    benign({
      deadlineMs: 0,
      liability: {
        mandate: null,
        oversightMode: "autonomous",
        blastRadius: { reversibility: "reversible" },
      },
    }),
  );
  add(
    "failmode-open",
    rOpen.failMode === "fail_open" && rOpen.latency.deadlineBreached,
    `reversible deadline=0 -> failMode=${rOpen.failMode}, breached=${rOpen.latency.deadlineBreached}`,
  );
  const rClosed = await pdp(
    benign({
      deadlineMs: 0,
      liability: {
        mandate: null,
        oversightMode: "human_in_loop",
        blastRadius: { financialAmount: 100, reversibility: "irreversible" },
      },
    }),
  );
  add(
    "failmode-closed",
    rClosed.failMode === "fail_closed" && rClosed.decision === "escalate",
    `irreversible deadline=0 -> failMode=${rClosed.failMode}, decision=${rClosed.decision}`,
  );

  // C5: citations are well-formed.
  add(
    "citations-shape",
    Array.isArray(r1.ruleCitations) &&
      r1.ruleCitations.every((c) => typeof c.ruleId === "string" && typeof c.pack === "string"),
    "ruleCitations well-formed",
  );

  const passed = cases.every((c) => c.passed);
  return { specVersion: PDP_SPEC_VERSION, passed, cases };
}
