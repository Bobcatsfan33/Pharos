import { describe, it, expect } from "vitest";
import { PharosClient, PharosError } from "@getpharos/sdk";

/**
 * SDK runtime input validation at the trust boundary (threat-model issue #80).
 *
 * The filed rationale was "defense-in-depth is server-side; the SDK is a thin client".
 * That is true for the *happy* path — the server does validate (`SubmitBodySchema`) and
 * returns 400, which the SDK correctly rethrows without retrying.
 *
 * It stops being true the moment the platform is unreachable. The SDK then makes a
 * safety decision *itself*, reading `liability.blastRadius.reversibility` out of the
 * same unvalidated object to choose fail-open or fail-closed. A caller that misspells a
 * field, nests it wrongly, or sends the wrong type gets a silent fall-through to the
 * configured default — and for an operator who has deliberately configured
 * `localFailMode: "fail_open"` for reversible low-stakes work, that means an
 * IRREVERSIBLE action is locally ALLOWED because of a typo the server never got to see.
 *
 * The server cannot defend that path, because by definition the server is not reachable.
 * So validation has to happen before transmit.
 */
const unreachable = () => Promise.reject(new Error("connect ECONNREFUSED"));

function client(localFailMode: "fail_open" | "fail_closed" = "fail_closed") {
  return new PharosClient({
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    maxRetries: 0,
    localFailMode,
    fetchImpl: unreachable as unknown as typeof fetch,
  });
}

/** A client whose transport records whether anything was ever sent. */
function recordingClient() {
  const sent: unknown[] = [];
  const c = new PharosClient({
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    maxRetries: 0,
    fetchImpl: (async (_u: unknown, init: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "null"));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { client: c, sent };
}

const action = { type: "email.send", agentId: "a1", payload: {} };
const goodLiability = {
  mandate: null,
  oversightMode: "autonomous" as const,
  blastRadius: { financialAmount: 0, currency: "USD", reversibility: "irreversible" as const },
  modelMetadata: null,
};

describe("SDK rejects invalid input before transmit", () => {
  it("does not send anything when the input is invalid", async () => {
    const { client: c, sent } = recordingClient();
    await expect(
      c.submit({ tenantId: "", action, liability: goodLiability } as never),
    ).rejects.toThrow(PharosError);
    // Reject BEFORE transmit: an invalid action must never reach the wire.
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["a missing tenantId", { action, liability: goodLiability }],
    ["an empty tenantId", { tenantId: "  ", action, liability: goodLiability }],
    ["a missing action", { tenantId: "t", liability: goodLiability }],
    [
      "an action without a type",
      { tenantId: "t", action: { agentId: "a" }, liability: goodLiability },
    ],
    [
      "an action without an agentId",
      { tenantId: "t", action: { type: "email.send" }, liability: goodLiability },
    ],
    ["a missing liability", { tenantId: "t", action }],
    [
      "an unknown oversightMode",
      {
        tenantId: "t",
        action,
        liability: { ...goodLiability, oversightMode: "supervised" },
      },
    ],
    [
      "an unknown reversibility",
      {
        tenantId: "t",
        action,
        liability: {
          ...goodLiability,
          blastRadius: { ...goodLiability.blastRadius, reversibility: "Irreversible" },
        },
      },
    ],
    [
      "a misspelled blastRadius key",
      {
        tenantId: "t",
        action,
        liability: {
          mandate: null,
          oversightMode: "autonomous",
          blastradius: { reversibility: "irreversible" },
        },
      },
    ],
    [
      "a negative financialAmount",
      {
        tenantId: "t",
        action,
        liability: {
          ...goodLiability,
          blastRadius: { ...goodLiability.blastRadius, financialAmount: -1 },
        },
      },
    ],
    [
      "a non-object payload",
      { tenantId: "t", action: { ...action, payload: "nope" }, liability: goodLiability },
    ],
  ])("rejects %s with a named error", async (_name, input) => {
    await expect(client().submit(input as never)).rejects.toThrow(PharosError);
    await expect(client().submit(input as never)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("names the offending field so the caller can fix it", async () => {
    await expect(
      client().submit({
        tenantId: "t",
        action,
        liability: {
          ...goodLiability,
          blastRadius: { ...goodLiability.blastRadius, reversibility: "Irreversible" },
        },
      } as never),
    ).rejects.toThrow(/liability\.blastRadius\.reversibility/);
  });

  it("does not coerce: a numeric tenantId is rejected, not stringified", async () => {
    const { client: c, sent } = recordingClient();
    await expect(
      c.submit({ tenantId: 42, action, liability: goodLiability } as never),
    ).rejects.toThrow(PharosError);
    expect(sent).toHaveLength(0);
  });

  it("accepts a valid submission and transmits it unchanged", async () => {
    const { client: c, sent } = recordingClient();
    const input = { tenantId: "t", action, liability: goodLiability, idempotencyKey: "k1" };
    await c.submit(input).catch(() => {});
    expect(sent).toHaveLength(1);
    // No silent rewriting of what the caller asked to govern.
    expect(sent[0]).toEqual(input);
  });
});

describe("the safety hazard #80 actually creates", () => {
  it("a typo'd liability must NOT let an irreversible action fail open locally", async () => {
    // The operator has deliberately chosen fail_open for reversible, low-stakes work.
    // The caller sends an IRREVERSIBLE action but misspells the blast-radius key.
    // Before validation: reversibility reads as undefined -> falls through to the
    // configured fail_open -> the irreversible action is locally ALLOWED, and the
    // server never saw it because the server was unreachable.
    const malformed = {
      tenantId: "t",
      action,
      liability: {
        mandate: null,
        oversightMode: "autonomous",
        blastradius: { reversibility: "irreversible" }, // lower-case r: wrong key
      },
    };

    await expect(client("fail_open").submit(malformed as never)).rejects.toThrow(PharosError);
    await expect(client("fail_open").submit(malformed as never)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("a well-formed irreversible action still fails closed when unreachable", async () => {
    // The existing fail-mode contract is untouched for valid input.
    const res = await client("fail_open").submit({
      tenantId: "t",
      action,
      liability: goodLiability,
    });
    expect(res.localFallback).toBe(true);
    expect(res.verdict.failMode).toBe("fail_closed");
    expect(res.verdict.decision).toBe("escalate");
  });
});
