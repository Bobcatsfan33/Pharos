import { describe, expect, it } from "vitest";
import { LocalKms } from "@pharos/core";
import { MemoryKeystore } from "./support/memoryKeystore.js";
import {
  canonicalPolicyIr,
  importCedarPolicy,
  importOpaPolicy,
  signPolicyBundle,
  verifyPolicyBundle,
} from "@pharos/policy";

describe("policy interoperability", () => {
  it("imports OPA JSON into citation-preserving canonical rules", () => {
    const imported = importOpaPolicy({
      package: "treasury.guardrails",
      revision: "git:abc123",
      rules: [
        {
          name: "large-wire",
          effect: "escalate",
          description: "Large wires require review",
          clause: "treasury-4.2",
          when: { path: "liability.blastRadius.financialAmount", operator: "gte", value: 25_000 },
        },
      ],
    });
    expect(imported.artifact.packId).toBe("opa:treasury.guardrails");
    expect(imported.artifact.rules[0]?.ruleId).toBe("opa:large-wire");
    expect(canonicalPolicyIr(imported.artifact)).toContain("treasury-4.2");
  });

  it("imports Cedar forbid policies and records default permits as warnings", () => {
    const imported = importCedarPolicy({
      namespace: "Acme",
      revision: "7",
      policies: [
        { id: "normal-mail", effect: "permit", actions: ["email.send"] },
        {
          id: "block-export",
          effect: "forbid",
          actions: ["data.export"],
          conditions: [{ path: "action.payload.classification", operator: "eq", value: "secret" }],
        },
      ],
    });
    expect(imported.warnings).toHaveLength(1);
    expect(imported.artifact.rules[0]?.decision).toBe("block");
  });

  it("signs bundles and detects artifact tampering", async () => {
    const signer = new LocalKms(new MemoryKeystore());
    const imported = importOpaPolicy({
      package: "tools",
      revision: "1",
      rules: [
        {
          name: "shell",
          effect: "block",
          description: "No shell",
          when: { path: "action.type", operator: "eq", value: "tool.shell" },
        },
      ],
    });
    const bundle = await signPolicyBundle(
      imported,
      signer,
      "policy:acme",
      "2026-08-30T00:00:00.000Z",
    );
    expect(await verifyPolicyBundle(bundle, signer)).toBe(true);
    bundle.artifact.rules[0]!.description = "tampered";
    expect(await verifyPolicyBundle(bundle, signer)).toBe(false);
  });
});
