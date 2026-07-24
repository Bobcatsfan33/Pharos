import { describe, it, expect } from "vitest";
import {
  CircuitBreaker,
  ResilientSigner,
  KmsUnavailableError,
  isKmsConnectivityError,
  type SigningProvider,
} from "@pharos/core";

// A stub signer whose behaviour is driven per-call, to exercise the resilience wrapper without
// any real KMS. `mode` flips between healthy and "connectivity down".
function stubSigner(state: { mode: "ok" | "down" | "other" }): SigningProvider {
  const fail = (): never => {
    if (state.mode === "down")
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    throw new Error("some other KMS error"); // not connectivity → must pass through
  };
  const okOr = <T>(v: T): T => {
    if (state.mode !== "ok") return fail();
    return v;
  };
  return {
    providerId: "stub",
    ensureKey: async () => okOr("k#v1"),
    rotate: async () => okOr("k#v2"),
    activeKeyId: async () => okOr("k#v1"),
    sign: async () => okOr("sig"),
    verify: async () => okOr(true),
    getPublicKey: async () => okOr(null),
    publishKeyset: async () => okOr([]),
  };
}

describe("isKmsConnectivityError", () => {
  it("classifies connectivity failures, not service errors", () => {
    expect(isKmsConnectivityError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      true,
    );
    expect(isKmsConnectivityError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(
      true,
    );
    expect(isKmsConnectivityError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isKmsConnectivityError(new Error("fetch failed"))).toBe(true);
    expect(isKmsConnectivityError(new Error("NotFoundException: key missing"))).toBe(false);
    expect(isKmsConnectivityError(new Error("AccessDenied"))).toBe(false);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the threshold, short-circuits, then half-opens after cooldown", () => {
    let clock = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => clock });
    expect(b.shouldShortCircuit()).toBe(false);
    b.recordFailure();
    b.recordFailure();
    expect(b.shouldShortCircuit()).toBe(false); // 2 < 3
    b.recordFailure();
    expect(b.status).toBe("open");
    expect(b.shouldShortCircuit()).toBe(true); // fail fast
    clock += 1000; // cooldown elapsed
    expect(b.shouldShortCircuit()).toBe(false); // half-open: allow a trial
    b.recordSuccess();
    expect(b.status).toBe("closed");
  });
});

describe("ResilientSigner", () => {
  it("wraps connectivity failures as KmsUnavailableError and fires the metric hook", async () => {
    const state = { mode: "down" as "ok" | "down" | "other" };
    let unavailable = 0;
    const signer = new ResilientSigner(stubSigner(state), {
      failureThreshold: 2,
      onKmsUnavailable: () => (unavailable += 1),
    });

    await expect(signer.sign("k#v1", Buffer.from("m"))).rejects.toBeInstanceOf(KmsUnavailableError);
    expect(unavailable).toBe(1);
  });

  it("passes non-connectivity errors through unchanged", async () => {
    const state = { mode: "other" as "ok" | "down" | "other" };
    const signer = new ResilientSigner(stubSigner(state));
    await expect(signer.sign("k#v1", Buffer.from("m"))).rejects.toThrow("some other KMS error");
    await expect(signer.sign("k#v1", Buffer.from("m"))).rejects.not.toBeInstanceOf(
      KmsUnavailableError,
    );
  });

  it("opens the breaker after repeated failures, then short-circuits without calling KMS", async () => {
    const state = { mode: "down" as "ok" | "down" | "other" };
    let unavailable = 0;
    const signer = new ResilientSigner(stubSigner(state), {
      failureThreshold: 2,
      cooldownMs: 60_000,
      onKmsUnavailable: () => (unavailable += 1),
    });
    await expect(signer.sign("k#v1", Buffer.from("m"))).rejects.toBeInstanceOf(KmsUnavailableError); // 1
    await expect(signer.sign("k#v1", Buffer.from("m"))).rejects.toBeInstanceOf(KmsUnavailableError); // 2 -> opens
    // Even if KMS came back, the open breaker short-circuits immediately.
    state.mode = "ok";
    await expect(signer.sign("k#v1", Buffer.from("m"))).rejects.toBeInstanceOf(KmsUnavailableError);
    expect(unavailable).toBe(3);
  });

  it("recovers (closes) on the next success after cooldown", async () => {
    let clock = 0;
    const state = { mode: "down" as "ok" | "down" | "other" };
    const signer = new ResilientSigner(stubSigner(state), {
      failureThreshold: 1,
      cooldownMs: 500,
      now: () => clock,
    });
    await expect(signer.sign("k#v1", Buffer.from("m"))).rejects.toBeInstanceOf(KmsUnavailableError); // opens
    clock += 500;
    state.mode = "ok";
    await expect(signer.sign("k#v1", Buffer.from("m"))).resolves.toBe("sig"); // half-open trial succeeds
  });
});
