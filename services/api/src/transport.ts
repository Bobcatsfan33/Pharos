import type { PharosConfig } from "@pharos/config";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Return the warning that must be emitted before binding an externally reachable
 * plaintext listener with no declared TLS terminator. Production configuration rejects
 * this posture earlier; the warning protects development and staging compositions.
 */
export function transportBoundaryWarning(config: PharosConfig, listenHost: string): string | null {
  if (LOOPBACK_HOSTS.has(listenHost) || config.api.tlsTerminator) return null;
  return (
    `[security] API is binding ${listenHost} over plaintext HTTP without PHAROS_TLS_TERMINATOR. ` +
    "Do not expose this listener outside a trusted host; declare the ingress, mesh, gateway, or load balancer that terminates TLS."
  );
}
