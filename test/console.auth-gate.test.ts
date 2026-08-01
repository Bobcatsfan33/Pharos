import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../apps/console/middleware";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Console auth gate and nonce CSP (#79, the half #122 deferred).
 *
 * Two properties, both enforced before any route renders:
 *
 *   1. **No evidence route renders without a session.** A browser navigation is
 *      redirected to /signin; a fetch/XHR gets 401 rather than a login page body it
 *      would misparse as data.
 *   2. **`script-src` carries a per-request nonce, not `'unsafe-inline'`**, so an
 *      injected `<script>` cannot execute even if it reaches the page.
 *
 * This suite pins the edge gate. The *authoritative* auth check is `requireSession()`,
 * which cryptographically verifies the token server-side — verified live during
 * development: an expired token and a garbage token both redirect to /signin even though
 * the cookie is present, so the gate is verification, not mere cookie presence.
 *
 * As of #79's final PR the policy carries NO inline allowance at all: the console's 156
 * inline `style` props were converted to classes in `app/globals.css`, so `style-src` is
 * plain `'self'`. Both halves are asserted below, including a blanket check that no
 * `'unsafe-*'` token appears anywhere in the policy.
 */
const ORIGIN = "https://console.example.test";

function request(path: string, opts: { session?: string; accept?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.accept) headers.set("accept", opts.accept);
  if (opts.session) headers.set("cookie", `pharos_session=${opts.session}`);
  return new NextRequest(new URL(path, ORIGIN), { headers });
}

const csp = (r: { headers: Headers }) => r.headers.get("content-security-policy") ?? "";

describe("console auth gate", () => {
  it("redirects an unauthenticated navigation away from an evidence route", () => {
    const res = middleware(request("/ledger/evidence", { accept: "text/html" }));
    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/signin");
    // Where they were going is preserved as a PATH, never a full URL — a full URL here
    // is how a login redirect becomes an open redirect.
    expect(location).toContain(`from=${encodeURIComponent("/ledger/evidence")}`);
    expect(location).not.toMatch(/from=https?%3A/);
  });

  it("answers an unauthenticated XHR with 401, not a redirect", () => {
    const res = middleware(request("/ledger/chain", { accept: "application/json" }));
    expect(res.status).toBe(401);
  });

  it("still sets a CSP on the refusal itself", () => {
    // The refusal is a rendered response too; shipping it without a policy would leave
    // the one page an attacker can always reach unprotected.
    expect(csp(middleware(request("/ledger/chain", { accept: "text/html" })))).toContain(
      "default-src 'self'",
    );
  });

  it("lets the sign-in notice through without a session", () => {
    const res = middleware(request("/signin", { accept: "text/html" }));
    expect(res.status).toBe(200);
  });

  it("lets an authenticated request proceed", () => {
    const res = middleware(request("/ledger/evidence", { accept: "text/html", session: "t" }));
    expect(res.status).toBe(200);
  });

  it("gates every evidence route, not just a sample", () => {
    for (const path of [
      "/",
      "/beam/verdicts",
      "/beam/policies",
      "/beam/review",
      "/ledger/evidence",
      "/ledger/chain",
      "/ledger/risk-profile",
      "/ledger/claims-packs",
      "/ledger/access-audit",
    ]) {
      const res = middleware(request(path, { accept: "text/html" }));
      expect(res.status, `${path} must not render unauthenticated`).toBe(307);
    }
  });
});

describe("console nonce CSP", () => {
  it("uses a nonce and NOT 'unsafe-inline' for script-src", () => {
    const policy = csp(middleware(request("/signin", { accept: "text/html" })));
    const scriptSrc = policy.split(";").find((d) => d.trim().startsWith("script-src"))!;
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("issues a fresh nonce per request", () => {
    // A reused nonce is no better than 'unsafe-inline' — an attacker who learns it once
    // can sign their own script forever.
    const a = csp(middleware(request("/signin", { accept: "text/html" })));
    const b = csp(middleware(request("/signin", { accept: "text/html" })));
    const nonceOf = (p: string) => p.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    expect(nonceOf(a)).toBeTruthy();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });

  it("forwards the nonce to the app so Next can stamp its own scripts", () => {
    const res = middleware(request("/signin", { accept: "text/html" }));
    // Verified live: with this header set, all 11 script tags Next emits carry the
    // nonce and it matches the response header.
    expect(res.headers.get("x-middleware-request-x-nonce") ?? "").toBeTruthy();
  });

  it("keeps the confinement directives", () => {
    const policy = csp(middleware(request("/signin", { accept: "text/html" })));
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "connect-src 'self'",
    ]) {
      expect(policy).toContain(directive);
    }
  });

  it("permits NO inline styles — style-src is plain 'self'", () => {
    // The last named residual of #79. Nonces attach to <style>/<script> ELEMENTS and can
    // never cover a style ATTRIBUTE, so this could only be closed by removing the
    // attributes themselves — which app/globals.css did.
    const policy = csp(middleware(request("/signin", { accept: "text/html" })));
    const styleSrc = policy.split(";").find((d) => d.trim().startsWith("style-src"))!;
    expect(styleSrc.trim()).toBe("style-src 'self'");
    expect(styleSrc).not.toContain("'unsafe-inline'");
    expect(styleSrc).not.toMatch(/https?:/);
  });

  it("contains no 'unsafe-*' token anywhere in the policy", () => {
    // One assertion that cannot be satisfied by loosening a different directive.
    const policy = csp(middleware(request("/signin", { accept: "text/html" })));
    expect(policy).not.toMatch(/'unsafe-[a-z-]+'/);
  });
});

/**
 * With `style-src 'self'`, a single reintroduced `style` prop would be silently dropped
 * by the browser — the element renders unstyled and nothing fails loudly. So the absence
 * of style attributes is pinned at the source, not left to review.
 */
describe("console source carries no inline style attributes", () => {
  const appDir = fileURLToPath(new URL("../apps/console/app", import.meta.url));

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
    });
  }

  const files = tsxFiles(appDir);

  it("finds the console pages (so the check below cannot pass vacuously)", () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  it.each(files.map((f) => [f.slice(appDir.length + 1), f]))(
    "%s uses className, never a style prop",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/style=\{\{/);
      expect(source).not.toMatch(/style="/);
    },
  );
});
