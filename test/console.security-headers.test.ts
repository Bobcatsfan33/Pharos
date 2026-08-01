import { describe, it, expect } from "vitest";

/**
 * Console security headers (threat-model issue #79).
 *
 * The console shipped with no `headers()` at all — no CSP, no HSTS, no framing
 * protection. It renders evidence (verdicts, sealed records, chain state), which is
 * exactly the surface worth framing for clickjacking or injecting into to exfiltrate
 * what the server components rendered.
 *
 * This suite executes the real `next.config.mjs` rather than reading it as text, so it
 * pins the headers Next will actually emit. Verified against a running `next start`
 * during development: every header below was present on both static and dynamic routes,
 * and `x-powered-by` was absent.
 */
const config = (await import("../apps/console/next.config.mjs")).default as {
  poweredByHeader?: boolean;
  headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
};

const rules = await config.headers();
const applied = rules[0]!;
const header = (name: string): string | undefined =>
  applied.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;

describe("console static security headers", () => {
  // The Content-Security-Policy is deliberately NOT here any more: it carries a
  // per-request nonce and is set in middleware (#79). Emitting it from static config too
  // would send two CSP headers. That it is ABSENT here is itself part of the contract.
  it("does not emit a Content-Security-Policy from static config", () => {
    expect(header("Content-Security-Policy")).toBeUndefined();
  });

  it("still forbids framing through the legacy header", () => {
    // frame-ancestors moved to the middleware CSP; X-Frame-Options stays static.
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  it("applies to every path, not just the index", () => {
    expect(rules).toHaveLength(1);
    expect(applied.source).toBe("/:path*");
  });

  it("sets HSTS, nosniff, a private referrer policy, and a permissions policy", () => {
    expect(header("Strict-Transport-Security")).toMatch(/max-age=\d+/);
    expect(header("Strict-Transport-Security")).toContain("includeSubDomains");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    // Evidence URLs embed tenant and sequence — never send them cross-origin.
    expect(header("Referrer-Policy")).toBe("no-referrer");
    expect(header("Permissions-Policy")).toContain("camera=()");
    expect(header("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("does not advertise the framework version", () => {
    expect(config.poweredByHeader).toBe(false);
  });
});
