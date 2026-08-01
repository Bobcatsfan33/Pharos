import { NextResponse, type NextRequest } from "next/server";

/**
 * Console edge gate (#79): nonce-based CSP, and no evidence route renders unauthenticated.
 *
 * Two jobs, both of which have to happen before a route handler runs.
 *
 * 1. **Nonce CSP.** A fresh nonce per request replaces `'unsafe-inline'` in `script-src`,
 *    so an injected `<script>` cannot execute even if it reaches the page. Next's App
 *    Router propagates the nonce to its own bootstrap/flight scripts when it is set on
 *    both the request and response headers.
 *
 *    `style-src` still carries `'unsafe-inline'`. That is a real, named residual, not an
 *    oversight: the console styles components with React `style` props, which emit style
 *    *attributes*, and CSP nonces apply to `<style>`/`<script>` ELEMENTS — an attribute
 *    can never carry one. Removing it requires converting ~150 inline style props to CSS
 *    classes, which is a separate mechanical change. Script injection is the execution
 *    vector and it is closed here; inline style is a weaker exposure (exfiltration by
 *    selector, defacement).
 *
 * 2. **Auth presence gate.** A request with no session token is redirected before any
 *    route renders, so an unauthenticated caller never reaches code that fetches
 *    evidence. This is a cheap presence check — the *authoritative* check is
 *    `requireSession()`, which cryptographically verifies the token server-side before
 *    any page reads tenant data. Presence here, verification there; both fail closed.
 */
const SESSION_COOKIE = "pharos_session";

/** Routes reachable without a session. Everything else is evidence or leads to it. */
const PUBLIC_PATHS = ["/signin", "/healthz"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    // Nonce, not 'unsafe-inline'. `strict-dynamic` lets Next's nonced bootstrap load its
    // own chunks without enumerating them, and is ignored by browsers that do not
    // understand it (which then fall back to the 'self' source list).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // RESIDUAL (#79): React `style` props emit style attributes, which nonces cannot cover.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);

  const authenticated = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const { pathname } = request.nextUrl;

  if (!authenticated && !isPublic(pathname)) {
    // Non-navigation requests get a status, not a redirect: an XHR or fetch should see
    // 401 rather than a login page body it would misparse as data.
    const wantsHtml = request.headers.get("accept")?.includes("text/html");
    if (!wantsHtml) {
      const denied = new NextResponse(
        JSON.stringify({ error: "unauthenticated", message: "console session required" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      denied.headers.set("Content-Security-Policy", csp);
      return denied;
    }
    const signin = request.nextUrl.clone();
    signin.pathname = "/signin";
    // Preserve where they were going, path only — never the full URL, which could be
    // turned into an open redirect.
    signin.search = pathname === "/" ? "" : `?from=${encodeURIComponent(pathname)}`;
    const redirected = NextResponse.redirect(signin);
    redirected.headers.set("Content-Security-Policy", csp);
    return redirected;
  }

  // The nonce must be on the REQUEST headers for Next to reuse it in its own script tags,
  // and on the RESPONSE headers for the browser to honour it.
  const forwarded = new Headers(request.headers);
  forwarded.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Static assets carry no evidence and need no gate; excluding them keeps the redirect
  // from breaking the sign-in page's own styling.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
