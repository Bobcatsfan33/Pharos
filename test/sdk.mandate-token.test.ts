import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PharosClient,
  attenuateMandateToken,
  effectiveAuthority,
  verifyMandateToken,
  type MandateRootKey,
  type MandateToken,
  type SubmitResult,
} from "@getpharos/sdk";

/**
 * The TypeScript SDK's standalone verifier against the shared conformance vectors, plus the
 * client contract (Workstream A): an invalid token is a Tier-1 block decided locally AND still
 * submitted for sealing; a verified token goes to the server unless `localAllow` is on, in which
 * case a reversible, zero-amount, in-scope action is allowed optimistically with the sealed
 * record submitted behind it.
 */
interface Vector {
  name: string;
  description: string;
  rootKeyId: string;
  now: string;
  expect: { tenantId?: string; agentId?: string };
  token: MandateToken;
  result: { ok: boolean; code: string | null; effective: unknown };
}
const fixture = JSON.parse(
  readFileSync(
    new URL("../packages/core/test/mandate-token/vectors.json", import.meta.url),
    "utf8",
  ),
) as { keyset: MandateRootKey[]; vectors: Vector[] };
const keyset = new Map(fixture.keyset.map((k) => [k.keyId, k]));
const byName = Object.fromEntries(fixture.vectors.map((v) => [v.name, v]));
const valid = byName["valid-chain"]!;

describe("SDK MandateToken verifier — conformance vectors", () => {
  for (const v of fixture.vectors) {
    it(`${v.name}: ${v.description}`, async () => {
      const r = await verifyMandateToken(v.token, keyset.get(v.rootKeyId)!, new Date(v.now), {
        expect: v.expect,
      });
      expect(r.ok).toBe(v.result.ok);
      expect(r.code).toBe(v.result.code);
      if (v.result.ok) {
        expect(r.effective).toEqual(v.result.effective);
        expect(effectiveAuthority(v.token)).toEqual(v.result.effective);
        expect(r.blockHashes).toHaveLength(v.token.blocks.length + 1);
      } else expect(r.effective).toBeNull();
    });
  }

  it("holder-side attenuation narrows and verifies, and refuses to widen", async () => {
    const narrower = await attenuateMandateToken(valid.token, {
      checks: [{ kind: "limit", value: { financialAmount: 10 } }],
      issuedAt: new Date().toISOString(),
    });
    const r = await verifyMandateToken(narrower, keyset.get(valid.rootKeyId)!, new Date(valid.now));
    expect(r.ok).toBe(true);
    expect(r.effective?.limits.financialAmount).toBe(10);
    expect(narrower.blocks).toHaveLength(3);
    await expect(
      attenuateMandateToken(valid.token, {
        checks: [{ kind: "limit", value: { financialAmount: 6000 } }],
        issuedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/widens/);
  });
});

/** A fetch stub that records submissions and answers like the server would. */
function fakeServer(decision: "allow" | "block" = "allow") {
  const calls: unknown[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          verdict: {
            decision,
            tierReached: 1,
            riskScore: 0,
            ruleCitations: [],
            failMode: null,
            judgeVersion: null,
            latency: { totalMs: 1, perTier: {}, deadlineMs: 800, deadlineBreached: false },
          },
          record: { content: { id: "r1", sequence: 1 } },
          escalation: null,
        },
        error: null,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const liability = (reversibility: "reversible" | "irreversible" = "reversible", amount = 0) => ({
  mandate: null,
  oversightMode: "autonomous" as const,
  blastRadius: { financialAmount: amount, currency: "USD", reversibility },
  modelMetadata: null,
});
const action = (type = "payment.transfer") => ({ type, agentId: "treasury-agent", payload: {} });

describe("SDK client — MandateToken contract", () => {
  it("an invalid token is a Tier-1 block decided locally, and the request is still submitted for sealing", async () => {
    const server = fakeServer("block");
    const events: string[] = [];
    const client = new PharosClient({
      baseUrl: "http://pharos",
      apiKey: "k",
      fetchImpl: server.fetchImpl,
      mandateToken: { rootKeys: fixture.keyset },
      onEvent: (e) => events.push(e.type),
    });
    const res = await client.submit({
      tenantId: "acme",
      action: action(),
      liability: liability(),
      mandateToken: byName["truncated-chain"]!.token,
    });
    expect(res.localVerdict).toBe("mandate-token-invalid");
    expect(res.verdict.decision).toBe("block");
    expect(res.verdict.ruleCitations[0]).toMatchObject({
      ruleId: "mandate-token-invalid",
      pack: "core",
    });
    expect(res.verdict.ruleCitations[0]!.description).toContain("proof");
    const sealed = (await res.sealed) as SubmitResult;
    expect(sealed.record.content.id).toBe("r1");
    expect(server.calls).toHaveLength(1);
    expect((server.calls[0] as { mandateToken: unknown }).mandateToken).toEqual(
      byName["truncated-chain"]!.token,
    );
    expect(events).toContain("local-verdict");
    expect(events).not.toContain("local-verdict-diverged");
  });

  it("a verified token goes to the server when localAllow is off (the default)", async () => {
    const server = fakeServer("allow");
    const client = new PharosClient({
      baseUrl: "http://pharos",
      apiKey: "k",
      fetchImpl: server.fetchImpl,
      mandateToken: { rootKeys: fixture.keyset },
    });
    const res = await client.submit({
      tenantId: "acme",
      action: action(),
      liability: liability(),
      mandateToken: valid.token,
    });
    expect(res.localVerdict).toBeUndefined();
    expect(res.record.content.id).toBe("r1");
    expect(server.calls).toHaveLength(1);
  });

  it("without root keys the SDK verifies nothing locally and the server decides", async () => {
    const server = fakeServer("block");
    const client = new PharosClient({
      baseUrl: "http://pharos",
      apiKey: "k",
      fetchImpl: server.fetchImpl,
    });
    const res = await client.submit({
      tenantId: "acme",
      action: action(),
      liability: liability(),
      mandateToken: byName["truncated-chain"]!.token,
    });
    expect(res.localVerdict).toBeUndefined();
    expect(res.verdict.decision).toBe("block");
  });

  it("localAllow: a reversible, zero-amount, in-scope action is allowed optimistically; divergence is reported", async () => {
    const server = fakeServer("block"); // the server (Tier 2/3) disagrees
    const events: Array<{ type: string }> = [];
    const client = new PharosClient({
      baseUrl: "http://pharos",
      apiKey: "k",
      fetchImpl: server.fetchImpl,
      mandateToken: { rootKeys: fixture.keyset, localAllow: true },
      onEvent: (e) => events.push(e),
    });
    const res = await client.submit({
      tenantId: "acme",
      action: action(),
      liability: liability(),
      mandateToken: valid.token,
    });
    expect(res.localVerdict).toBe("mandate-token-allow");
    expect(res.verdict.decision).toBe("allow");
    const sealed = await res.sealed!;
    expect(sealed.verdict.decision).toBe("block");
    expect(events.map((e) => e.type)).toContain("local-verdict-diverged");

    // Never for: out of scope, money, irreversible.
    for (const [a, l] of [
      [action("payment.refund"), liability()],
      [action(), liability("reversible", 5)],
      [action(), liability("irreversible")],
    ] as const) {
      const r = await client.submit({
        tenantId: "acme",
        action: a,
        liability: l,
        mandateToken: valid.token,
      });
      expect(r.localVerdict, `${a.type} ${JSON.stringify(l.blastRadius)}`).toBeUndefined();
    }
  });

  it("refuses a token combined with a mandateId before transmit", async () => {
    const server = fakeServer();
    const client = new PharosClient({
      baseUrl: "http://pharos",
      apiKey: "k",
      fetchImpl: server.fetchImpl,
    });
    await expect(
      client.submit({
        tenantId: "acme",
        action: action(),
        liability: liability(),
        mandateId: "m",
        mandateToken: valid.token,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(server.calls).toHaveLength(0);
  });
});
