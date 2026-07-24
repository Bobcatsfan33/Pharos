import { describe, it, expect } from "vitest";
import { PharosClient } from "@getpharos/sdk";

// SDK local fail-mode conformance (TS). When the platform is unreachable — which includes a
// 503 kms_unavailable from S3-T2 — the SDK applies a local fail-mode that mirrors the server
// cascade: reversible → fail_open (allow), irreversible → fail_closed (escalate). The Python
// SDK conformance for the same contract lives in sdks/python/tests/test_failmode.py.
const unreachable = () => Promise.reject(new Error("connect ECONNREFUSED"));

function client(localFailMode: "fail_open" | "fail_closed") {
  return new PharosClient({
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    maxRetries: 0,
    localFailMode,
    fetchImpl: unreachable as unknown as typeof fetch,
  });
}

const action = { type: "email.send", agentId: "a1", payload: {} };
const liability = (reversibility: "reversible" | "irreversible") => ({
  mandate: null,
  oversightMode: "autonomous" as const,
  blastRadius: { financialAmount: 0, currency: "USD", reversibility },
  modelMetadata: null,
});

describe("SDK local fail-mode (reversibility-aware)", () => {
  it("reversible action fails OPEN (allow) even when the default is fail_closed", async () => {
    const res = await client("fail_closed").submit({
      tenantId: "t",
      action,
      liability: liability("reversible"),
    });
    expect(res.localFallback).toBe(true);
    expect(res.verdict.decision).toBe("allow");
    expect(res.verdict.failMode).toBe("fail_open");
  });

  it("irreversible action fails CLOSED (escalate) even when the default is fail_open", async () => {
    const res = await client("fail_open").submit({
      tenantId: "t",
      action,
      liability: liability("irreversible"),
    });
    expect(res.localFallback).toBe(true);
    expect(res.verdict.decision).toBe("escalate");
    expect(res.verdict.failMode).toBe("fail_closed");
  });
});
