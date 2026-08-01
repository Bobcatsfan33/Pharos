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

describe("console security headers", () => {
  it("applies to every path, not just the index", () => {
    expect(rules).toHaveLength(1);
    expect(applied.source).toBe("/:path*");
  });

  it("sets a Content-Security-Policy that confines loads to this origin", () => {
    const csp = header("Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
  });

  it("forbids framing through both the modern and legacy controls", () => {
    // Clickjacking an evidence view is the concrete risk; browsers honour one or the
    // other, so both are set.
    expect(header("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  it("does not permit remote script or style origins", () => {
    const csp = header("Content-Security-Policy")!;
    // 'unsafe-inline' is a documented residual; loading code from another origin is not.
    expect(csp).not.toMatch(/script-src[^;]*https?:/);
    expect(csp).not.toMatch(/style-src[^;]*https?:/);
    expect(csp).not.toContain("'unsafe-eval'");
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
