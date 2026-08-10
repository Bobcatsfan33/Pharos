import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAdminToken } from "../services/api/src/auth.js";
import type { Platform } from "../services/api/src/platform.js";

/**
 * Constant-time comparison of the platform admin token (threat-model issue #75).
 *
 * `requireAdminToken` guards tenant provisioning — the highest-privilege credential in
 * the system — and compared it with `!==`. String inequality in V8 short-circuits at
 * the first differing byte, so the time to reject leaks how long a shared prefix the
 * guess had, which is the signal an attacker needs to recover a secret byte by byte.
 *
 * The fix hashes both sides to fixed-length digests and compares with
 * `timingSafeEqual`, mirroring `packages/identity/src/apiKeys.ts`. Hashing first
 * matters for two reasons: `timingSafeEqual` throws on length mismatch, and comparing
 * raw buffers behind a length guard would still leak the token's *length*.
 */
const TOKEN = "s3cret-platform-admin-token-value";

function fakeReply(): { reply: FastifyReply; captured: { status: number | null } } {
  const captured: { status: number | null } = { status: null };
  const reply = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    send() {
      return this;
    },
  };
  return { reply: reply as unknown as FastifyReply, captured };
}

function platformWith(
  token: string | undefined,
  options: {
    tokenExpiresAt?: string;
    previousToken?: string;
    previousTokenExpiresAt?: string;
  } = {},
): Platform {
  return { config: { admin: { token, ...options } } } as unknown as Platform;
}

function requestWith(header: unknown): FastifyRequest {
  return { headers: { "x-pharos-admin": header } } as unknown as FastifyRequest;
}

describe("platform admin token guard", () => {
  it("accepts the correct token", () => {
    const { reply, captured } = fakeReply();
    expect(requireAdminToken(platformWith(TOKEN), requestWith(TOKEN), reply)).toBe(true);
    expect(captured.status).toBeNull();
  });

  it("rejects a wrong token of the same length", () => {
    const { reply, captured } = fakeReply();
    const wrong = "X" + TOKEN.slice(1);
    expect(wrong).toHaveLength(TOKEN.length);
    expect(requireAdminToken(platformWith(TOKEN), requestWith(wrong), reply)).toBe(false);
    expect(captured.status).toBe(401);
  });

  it("rejects a token that is a correct prefix but truncated", () => {
    // The case a length-guarded raw compare would answer faster than a full-length
    // mismatch, leaking the token's length.
    const { reply, captured } = fakeReply();
    expect(requireAdminToken(platformWith(TOKEN), requestWith(TOKEN.slice(0, 5)), reply)).toBe(
      false,
    );
    expect(captured.status).toBe(401);
  });

  it("rejects a token with the correct value plus a suffix", () => {
    const { reply, captured } = fakeReply();
    expect(requireAdminToken(platformWith(TOKEN), requestWith(TOKEN + "x"), reply)).toBe(false);
    expect(captured.status).toBe(401);
  });

  it("rejects a missing or non-string header without throwing", () => {
    for (const header of [undefined, ["a", "b"], 42, null]) {
      const { reply, captured } = fakeReply();
      expect(requireAdminToken(platformWith(TOKEN), requestWith(header), reply)).toBe(false);
      expect(captured.status).toBe(401);
    }
  });

  it("refuses with 503 when no admin token is configured, and never admits", () => {
    for (const presented of ["", "anything", TOKEN]) {
      const { reply, captured } = fakeReply();
      // An unset token must not become a wildcard that any presented value satisfies.
      expect(requireAdminToken(platformWith(undefined), requestWith(presented), reply)).toBe(false);
      expect(captured.status).toBe(503);
    }
  });

  it("rejects an input of wildly different length without throwing", () => {
    // timingSafeEqual throws on unequal buffer lengths, so an implementation that fed
    // it raw token bytes would crash here rather than return 401.
    const { reply, captured } = fakeReply();
    const long = randomBytes(4096).toString("hex");
    expect(requireAdminToken(platformWith(TOKEN), requestWith(long), reply)).toBe(false);
    expect(captured.status).toBe(401);
  });

  it("accepts both credentials only during a bounded rotation overlap", () => {
    const previous = "previous-platform-admin-token-value";
    const overlap = platformWith(TOKEN, {
      tokenExpiresAt: "2099-01-01T00:00:00Z",
      previousToken: previous,
      previousTokenExpiresAt: "2099-01-01T00:00:00Z",
    });
    for (const candidate of [TOKEN, previous]) {
      const { reply, captured } = fakeReply();
      expect(requireAdminToken(overlap, requestWith(candidate), reply)).toBe(true);
      expect(captured.status).toBeNull();
    }
  });

  it("rejects expired current and previous credentials", () => {
    const previous = "previous-platform-admin-token-value";
    const expired = platformWith(TOKEN, {
      tokenExpiresAt: "2020-01-01T00:00:00Z",
      previousToken: previous,
      previousTokenExpiresAt: "2020-01-01T00:00:00Z",
    });
    for (const candidate of [TOKEN, previous]) {
      const { reply, captured } = fakeReply();
      expect(requireAdminToken(expired, requestWith(candidate), reply)).toBe(false);
      expect(captured.status).toBe(401);
    }
  });
});

/**
 * The behavioral tests above cannot observe timing — `!==` and a constant-time compare
 * return the same answers, so they would pass against the vulnerable code. This suite
 * is therefore the actual regression guard for #75: it pins the *implementation* to a
 * constant-time comparison, and fails if anyone reintroduces a short-circuiting one.
 *
 * Source-level assertion, following the precedent in `docs.command-integrity.test.ts`
 * that treats an executable property as something to pin rather than trust.
 */
describe("admin token comparison is constant-time by construction", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../services/api/src/auth.ts", import.meta.url)),
    "utf8",
  );
  const anchor = source.indexOf("function secretsMatch");
  // If the helper is deleted the slice below would be meaningless and the negative
  // assertions would pass vacuously, so its presence is asserted, not assumed.
  const body = anchor >= 0 ? source.slice(anchor) : "";

  it("defines a dedicated constant-time comparison helper", () => {
    expect(anchor).toBeGreaterThanOrEqual(0);
  });

  it("uses timingSafeEqual", () => {
    expect(source).toMatch(/timingSafeEqual/);
    expect(body).toMatch(/timingSafeEqual/);
  });

  it("never compares the presented token to the expected one with === or !==", () => {
    expect(body).not.toBe("");
    // A short-circuiting comparison of the two secrets is the defect itself.
    expect(body).not.toMatch(/token\s*!==\s*expected/);
    expect(body).not.toMatch(/expected\s*!==\s*token/);
    expect(body).not.toMatch(/token\s*===\s*expected/);
    expect(body).not.toMatch(/expected\s*===\s*token/);
  });

  it("hashes both sides to a fixed width before comparing", () => {
    // Comparing raw buffers behind a length guard would still leak the token length,
    // so both sides are reduced to a SHA-256 digest first.
    expect(body).toMatch(/createHash\(["']sha256["']\)/);
  });
});
