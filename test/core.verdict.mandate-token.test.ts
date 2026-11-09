import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VerdictEngine,
  applyMandateToken,
  resolveVerdictRequest,
  type MandateToken,
  type PublicKeyEntry,
  type VerdictRequest,
} from "@pharos/core";

/**
 * Tier 1 with a MandateToken (Workstream A): a verified token supersedes the server-side mandate
 * and is sealed as block hashes + the effective authority; a refused token is a block whose
 * reason is sealed; and the engine reaches the same verdict from the sealed liability alone
 * (replay), with no token and no key.
 */
const fixture = JSON.parse(
  readFileSync(
    new URL("../packages/core/test/mandate-token/vectors.json", import.meta.url),
    "utf8",
  ),
) as {
  keyset: PublicKeyEntry[];
  vectors: Array<{ name: string; now: string; token: MandateToken }>;
};
const root = fixture.keyset.find((k) => k.keyId === "mandate:acme#v1")!;
const vec = (name: string) => fixture.vectors.find((v) => v.name === name)!;
const valid = vec("valid-chain"); // payment.transfer only, ≤ 5000 USD, reversible, expires 2035-11-01
const now = new Date(valid.now);
const engine = new VerdictEngine({ deadlineMs: 800 });

function req(
  type: string,
  amount: number,
  token: MandateToken,
  over: Partial<VerdictRequest> = {},
): VerdictRequest {
  return {
    tenantId: "acme",
    action: { type, agentId: "treasury-agent", payload: { amount }, emittedAt: now.toISOString() },
    liability: {
      mandate: null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: amount, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
    },
    mandateToken: { token, rootKey: root },
    ...over,
  };
}

describe("Tier 1 — MandateToken", () => {
  it("a verified token supersedes the server-side mandate and its hashes are sealed", () => {
    const resolved = resolveVerdictRequest(req("payment.transfer", 100, valid.token), now);
    expect(resolved.mandateToken).toBeUndefined();
    expect(resolved.liability.mandate).toMatchObject({
      id: "vendor-payments",
      grantor: "cfo",
      version: "token",
      limits: { maxAmount: 5000, currency: "USD", reversibility: "reversible" },
      expiresAt: "2035-11-01T00:00:00.000Z",
    });
    // Scope is sealed with the token, not written into limits.actionTypes (D3 reads it later).
    expect(resolved.liability.mandate!.limits).not.toHaveProperty("actionTypes");
    expect(resolved.liability.mandateToken).toMatchObject({
      rootKeyId: "mandate:acme#v1",
      verification: "verified",
      effective: { scope: { actionTypes: ["payment.transfer"] } },
    });
    expect(resolved.liability.mandateToken!.blockHashes).toHaveLength(3);
    expect(resolved.liability.mandateToken!.headHash).toMatch(/^[0-9a-f]{64}$/);
    const v = engine.evaluate(req("payment.transfer", 100, valid.token), now);
    expect(v.decision).toBe("allow");
  });

  it("the token's ceiling drives the existing mandate-limit rule", () => {
    const v = engine.evaluate(req("payment.transfer", 6000, valid.token), now);
    expect(v.decision).toBe("block");
    expect(v.ruleCitations.map((c) => c.ruleId)).toContain("mandate-limit-exceeded");
  });

  it("an action outside the token's effective scope is blocked at Tier 1", () => {
    const v = engine.evaluate(req("payment.refund", 10, valid.token), now);
    expect(v.decision).toBe("block");
    expect(v.ruleCitations.map((c) => c.ruleId)).toEqual(["mandate-token-scope"]);
  });

  it("a refused token is a block with the structural reason sealed", () => {
    for (const [name, code] of [
      ["truncated-chain", "proof"],
      ["widened-scope", "widening"],
      ["tampered-block", "block-signature"],
    ] as const) {
      const r = req("payment.transfer", 10, vec(name).token);
      const resolved = resolveVerdictRequest(r, now);
      expect(resolved.liability.mandate).toBeNull();
      expect(resolved.liability.mandateToken?.verification).toBe(code);
      const v = engine.evaluate(r, now);
      expect(v.decision, name).toBe("block");
      expect(v.ruleCitations[0]).toMatchObject({ ruleId: "mandate-token-invalid", pack: "core" });
      expect(v.ruleCitations[0]!.description).toContain(code);
    }
  });

  it("an unknown root key, a wrong tenant, a wrong agent, and a revoked mandate are blocks too", () => {
    expect(
      engine.evaluate(
        req("payment.transfer", 10, valid.token, {
          mandateToken: { token: valid.token, rootKey: null },
        }),
        now,
      ).ruleCitations[0]!.description,
    ).toContain("root-key-unknown");
    expect(
      resolveVerdictRequest(
        { ...req("payment.transfer", 10, valid.token), tenantId: "globex" },
        now,
      ).liability.mandateToken?.verification,
    ).toBe("tenant-mismatch");
    const otherAgent = req("payment.transfer", 10, valid.token);
    otherAgent.action = { ...otherAgent.action, agentId: "someone-else" };
    expect(resolveVerdictRequest(otherAgent, now).liability.mandateToken?.verification).toBe(
      "agent-mismatch",
    );
    const revoked = applyMandateToken(otherAgent.liability, valid.token, root, now, {
      expect: { tenantId: "acme" },
      revoked: true,
    });
    expect(revoked.mandateToken?.verification).toBe("mandate-revoked");
    expect(revoked.mandate).toBeNull();
  });

  it("replay: the sealed liability alone reproduces the verdict, with no token and no key", () => {
    for (const r of [
      req("payment.transfer", 100, valid.token),
      req("payment.refund", 10, valid.token),
      req("payment.transfer", 10, vec("widened-limit").token),
    ]) {
      const live = engine.evaluate(r, now);
      const sealedLiability = resolveVerdictRequest(r, now).liability;
      const replayed = engine.evaluate(
        { tenantId: r.tenantId, action: r.action, liability: sealedLiability },
        now,
      );
      expect(replayed.decision).toBe(live.decision);
      expect(replayed.ruleCitations).toEqual(live.ruleCitations);
    }
  });
});
