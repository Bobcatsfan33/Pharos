import { describe, expect, it } from "vitest";
import type { PharosConfig } from "@pharos/config";
import { transportBoundaryWarning } from "../services/api/src/transport.js";

function config(tlsTerminator?: string): PharosConfig {
  return { api: { tlsTerminator } } as unknown as PharosConfig;
}

describe("plaintext listener trust-boundary declaration", () => {
  it.each(["127.0.0.1", "::1", "localhost"])("does not warn on loopback host %s", (host) => {
    expect(transportBoundaryWarning(config(), host)).toBeNull();
  });

  it("warns on an externally reachable bind without a terminator", () => {
    expect(transportBoundaryWarning(config(), "0.0.0.0")).toMatch(
      /plaintext HTTP without PHAROS_TLS_TERMINATOR/,
    );
  });

  it("accepts a named external terminator", () => {
    expect(transportBoundaryWarning(config("istio-ingressgateway"), "0.0.0.0")).toBeNull();
  });
});
