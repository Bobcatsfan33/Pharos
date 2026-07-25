import { describe, it, expect } from "vitest";
import { Rfc3161Tsa, verifyRfc3161Token } from "@pharos/evidence";

// LIVE test against a real RFC 3161 TSA over the network. Named *.spec.ts so it is NOT collected
// by the default `pnpm test` run (include = test/**/*.test.ts) — it must never flake CI on a TSA
// or network outage, and the CI skip-gate only governs the hermetic *.test.ts suite. Run it on
// demand with `pnpm test:live` (default TSA: FreeTSA; override with PHAROS_TSA_URL).
const TSA_URL = process.env.PHAROS_TSA_URL ?? "https://freetsa.org/tsr";

describe("live RFC 3161 TSA (network)", () => {
  it("requests a real timestamp and verifies it offline", async () => {
    const tsa = new Rfc3161Tsa(TSA_URL);
    const anchoredValue = `pharos-live-${Date.now()}-headhash`;

    const ts = await tsa.timestamp(anchoredValue);
    expect(ts.provider).toBe("rfc3161");
    expect(ts.hash).toBe(anchoredValue);
    expect(ts.token).toBeTruthy();
    expect(Date.parse(ts.time)).toBeGreaterThan(0);

    // Verify the freshly-issued token entirely offline (no further network).
    const v = verifyRfc3161Token(Buffer.from(ts.token!, "base64"), anchoredValue);
    expect(v.valid).toBe(true);
    expect(v.genTime).toBe(ts.time);

    // A different value must not verify against this token.
    expect(verifyRfc3161Token(Buffer.from(ts.token!, "base64"), "other").valid).toBe(false);
  }, 30_000);
});
