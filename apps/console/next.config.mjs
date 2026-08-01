/**
 * Console security headers (#79).
 *
 * The console renders evidence — verdicts, sealed records, chain state. It shipped with
 * no `headers()` at all: no CSP, no HSTS, no framing protection. Even as a read-only
 * dashboard that is a real exposure, because the page is exactly the surface an attacker
 * would want to frame (clickjacking) or inject into (to exfiltrate what the server
 * components rendered).
 *
 * These headers are deliberately scoped to what this app actually needs, and the two
 * `'unsafe-inline'` allowances are called out rather than hidden — see each residual.
 */
const CSP = [
  // Nothing loads from anywhere but this origin unless a directive below says otherwise.
  "default-src 'self'",
  // RESIDUAL (#79): Next's App Router injects inline bootstrap/flight scripts. Removing
  // 'unsafe-inline' requires nonce-based CSP wired through middleware, which belongs with
  // the auth gate before multi-tenant console GA.
  "script-src 'self' 'unsafe-inline'",
  // RESIDUAL (#79): the layout styles components with React `style` props, which emit
  // inline style attributes. Tightening this means CSS modules or a nonce.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  // The console talks to the API only from server components; the key never reaches the
  // browser, so the browser has no reason to reach the API directly.
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // frame-ancestors is the modern control; X-Frame-Options below covers browsers that
  // honour only the legacy header.
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  // The console is expected to be served over TLS at the ingress (see #76); this makes a
  // downgrade non-silent rather than invisible.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Evidence URLs embed tenant and sequence; do not leak them to third-party origins.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework version to every client.
  poweredByHeader: false,
  env: {
    PHAROS_API_BASE: process.env.PHAROS_API_BASE ?? "http://localhost:4000",
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
