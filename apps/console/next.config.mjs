/**
 * Console static security headers (#79).
 *
 * The Content-Security-Policy is NOT here. It carries a per-request nonce, so it is set
 * in `middleware.ts` alongside the auth gate — a header that must change every request
 * cannot come from static config. Emitting it in both places would send two CSP headers,
 * and a browser enforces the intersection, which is a confusing way to express a policy.
 *
 * What remains here is the genuinely static posture: transport, framing, sniffing,
 * referrer, and permissions.
 */
const SECURITY_HEADERS = [
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
  // The console verifies sessions with the platform's own @pharos/identity rather than a
  // parallel auth system (#79). That package is TypeScript source using ESM `.js`
  // specifiers, so webpack needs both instructions: transpile it, and map `.js` -> `.ts`.
  transpilePackages: ["@pharos/identity"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
