import { describe, expect, it } from "vitest";
import {
  assertUpstreamIdempotencyConformance,
  IDEMPOTENCY_CONFORMANCE_PROTOCOL,
} from "@pharos/gateway";

describe("gateway upstream idempotency conformance", () => {
  it("proves two deliveries produce one durable result", async () => {
    const results = new Map<string, string>();
    let executions = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      const replayed = results.has(key);
      if (!replayed) {
        executions++;
        results.set(key, `result-${executions}`);
      }
      return new Response(
        JSON.stringify({
          protocol: IDEMPOTENCY_CONFORMANCE_PROTOCOL,
          idempotencyKey: key,
          executions: 1,
          resultId: results.get(key),
        }),
        {
          status: 200,
          headers: { "x-idempotency-replayed": replayed ? "true" : "false" },
        },
      );
    };

    await expect(
      assertUpstreamIdempotencyConformance({
        target: "https://upstream.example.test",
        probePath: "/.well-known/pharos-idempotency",
        fetchImpl,
      }),
    ).resolves.toEqual({ resultId: "result-1" });
    expect(executions).toBe(1);
  });

  it("refuses an upstream that executes both attempts", async () => {
    let executions = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      executions++;
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      return new Response(
        JSON.stringify({
          protocol: IDEMPOTENCY_CONFORMANCE_PROTOCOL,
          idempotencyKey: key,
          executions,
          resultId: `result-${executions}`,
        }),
        { status: 200 },
      );
    };

    await expect(
      assertUpstreamIdempotencyConformance({
        target: "https://upstream.example.test",
        probePath: "/probe",
        fetchImpl,
      }),
    ).rejects.toThrow(/x-idempotency-replayed/);
    expect(executions).toBe(2);
  });

  it("refuses a replay marker without the original durable result", async () => {
    let attempt = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      attempt++;
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      return new Response(
        JSON.stringify({
          protocol: IDEMPOTENCY_CONFORMANCE_PROTOCOL,
          idempotencyKey: key,
          executions: 1,
          resultId: `result-${attempt}`,
        }),
        {
          status: 200,
          headers: { "x-idempotency-replayed": attempt === 2 ? "true" : "false" },
        },
      );
    };

    await expect(
      assertUpstreamIdempotencyConformance({
        target: "https://upstream.example.test",
        probePath: "/probe",
        fetchImpl,
      }),
    ).rejects.toThrow(/different result/);
  });

  it("refuses an upstream that marks the first execution as a replay", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      return new Response(
        JSON.stringify({
          protocol: IDEMPOTENCY_CONFORMANCE_PROTOCOL,
          idempotencyKey: key,
          executions: 1,
          resultId: "preexisting-result",
        }),
        {
          status: 200,
          headers: { "x-idempotency-replayed": "true" },
        },
      );
    };

    await expect(
      assertUpstreamIdempotencyConformance({
        target: "https://upstream.example.test",
        probePath: "/probe",
        fetchImpl,
      }),
    ).rejects.toThrow(/first attempt was incorrectly marked as a replay/);
  });
});
