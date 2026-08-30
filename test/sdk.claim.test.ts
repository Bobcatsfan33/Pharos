import { describe, expect, it } from "vitest";
import { PharosClient } from "@getpharos/sdk";

describe("SDK replay-safe escalation claim", () => {
  it("sends a stable claimId in the claim request", async () => {
    let body: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            claimed: true,
            status: "approved",
            resolution: null,
            escalation: { id: "e1", status: "approved", resolution: null },
          },
          error: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new PharosClient({ baseUrl: "https://pharos.test", apiKey: "k", fetchImpl });

    const result = await client.claim("acme", "e1", "keel:claim:v1:abc");

    expect(result.claimed).toBe(true);
    expect(body).toEqual({ claimId: "keel:claim:v1:abc" });
  });
});
