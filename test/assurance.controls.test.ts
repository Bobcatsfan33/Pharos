import { describe, expect, it } from "vitest";
import { PHAROS_CONTROL_PACK, complianceRegressions, evaluateControlPack } from "@pharos/assurance";

describe("compliance control mappings", () => {
  it("reports evidence coverage without claiming certification", () => {
    const evaluation = evaluateControlPack(
      PHAROS_CONTROL_PACK,
      {
        "evidence.chain_verified": true,
        "records.retained": true,
      },
      ["EU-AI-ACT"],
    );
    expect(evaluation.coverage).toBe(1);
    expect(evaluation.certificationClaimed).toBe(false);
  });

  it("keeps externally validated controls distinct from technical enforcement", () => {
    const evaluation = evaluateControlPack(
      PHAROS_CONTROL_PACK,
      {
        "identity.sso": true,
        "authorization.rbac": true,
        "audit.admin_events": true,
      },
      ["SOC-2"],
    );
    expect(evaluation.controls[0]!.status).toBe("external_validation_required");
  });

  it("detects continuous-control regressions", () => {
    const before = evaluateControlPack(
      PHAROS_CONTROL_PACK,
      { "eval.sliced_metrics": true, "drift.monitored": true },
      ["NIST-AI-RMF"],
    );
    const after = evaluateControlPack(PHAROS_CONTROL_PACK, { "eval.sliced_metrics": true }, [
      "NIST-AI-RMF",
    ]);
    expect(complianceRegressions(before, after).map((control) => control.id)).toContain(
      "nist-measure-2",
    );
  });
});
