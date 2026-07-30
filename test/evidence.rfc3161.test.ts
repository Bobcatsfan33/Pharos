import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  verifyRfc3161Token,
  buildTimeStampRequest,
  verifyTimestamp,
  requestTimestamp,
  type TrustedTimestamp,
} from "@pharos/evidence";

// Hermetic RFC 3161 tests. The fixture is a REAL FreeTSA TimeStampToken (see gen-fixture) so
// this proves offline verification of a genuine token with NO network — the token carries the
// TSA certificate. The live-against-FreeTSA test is test/live-tsa.spec.ts (excluded from the
// default suite so it can't flake the skip-gate on TSA/network outages).
type Fixture = { anchoredValue: string; genTime: string; tokenBase64: string };
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/rfc3161-token.json", import.meta.url)), "utf8"),
) as Fixture;
const tokenDer = Buffer.from(fixture.tokenBase64, "base64");
const FREE_TSA_FIXTURE_CERT_SHA256 =
  "32e841a95cc1164101ffde41298ef2fc75c1c4372ef095e88a6bbd47dfb191fc";

describe("RFC 3161 token verification (offline, real FreeTSA token)", () => {
  it("verifies a real token against the anchored value and extracts genTime", () => {
    const v = verifyRfc3161Token(tokenDer, fixture.anchoredValue);
    expect(v.valid).toBe(true);
    expect(v.genTime).toBe(fixture.genTime);
    expect(v.error).toBeUndefined();
  });

  it("accepts the token only when its signer matches an enterprise-approved certificate pin", () => {
    const trusted = verifyRfc3161Token(tokenDer, fixture.anchoredValue, {
      trustedCertSha256: [FREE_TSA_FIXTURE_CERT_SHA256],
    });
    const substituted = verifyRfc3161Token(tokenDer, fixture.anchoredValue, {
      trustedCertSha256: ["a".repeat(64)],
    });

    expect(trusted.valid).toBe(true);
    expect(substituted.valid).toBe(false);
    expect(substituted.error).toMatch(/not enterprise-approved/);
  });

  it("rejects a token verified against the WRONG anchored value (messageImprint mismatch)", () => {
    const v = verifyRfc3161Token(tokenDer, "some-other-hash");
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/messageImprint/);
  });

  it("rejects a tampered token (signature invalid)", () => {
    const tampered = Buffer.from(tokenDer);
    tampered[tampered.length - 20] ^= 0xff; // flip a byte inside the signature region
    const v = verifyRfc3161Token(tampered, fixture.anchoredValue);
    expect(v.valid).toBe(false);
  });

  it("rejects non-DER / garbage input", () => {
    expect(verifyRfc3161Token(Buffer.from("not der"), fixture.anchoredValue).valid).toBe(false);
  });

  it("builds a well-formed DER TimeStampReq", () => {
    const req = buildTimeStampRequest("head-hash-abc");
    expect(req.length).toBeGreaterThan(30);
    expect(req[0]).toBe(0x30); // SEQUENCE
  });

  it("fails closed when the contracted TSA is unavailable", async () => {
    await expect(
      requestTimestamp("https://tsa.example.test/tsr", fixture.anchoredValue, {
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("returned HTTP 503");
  });
});

describe("verifyTimestamp dispatch (rfc3161 vs local)", () => {
  it("rfc3161: valid when token verifies and recorded time matches genTime", () => {
    const ts: TrustedTimestamp = {
      hash: fixture.anchoredValue,
      time: fixture.genTime,
      provider: "rfc3161",
      token: fixture.tokenBase64,
    };
    // the local keyset verifier must be ignored for rfc3161
    expect(
      verifyTimestamp(ts, () => false, {
        trustedCertSha256: [FREE_TSA_FIXTURE_CERT_SHA256],
      }),
    ).toBe(true);
    expect(
      verifyTimestamp(ts, () => false, {
        trustedCertSha256: ["b".repeat(64)],
      }),
    ).toBe(false);
  });

  it("rfc3161: rejected when the recorded time is altered from the token's genTime", () => {
    const ts: TrustedTimestamp = {
      hash: fixture.anchoredValue,
      time: "2000-01-01T00:00:00.000Z",
      provider: "rfc3161",
      token: fixture.tokenBase64,
    };
    expect(verifyTimestamp(ts, () => true)).toBe(false);
  });

  it("local: still dispatches to the keyset verifier", () => {
    const ts: TrustedTimestamp = {
      hash: "h",
      time: "2026-01-01T00:00:00.000Z",
      provider: "local",
      keyId: "tsa#v1",
      signature: "sig",
    };
    let called = false;
    verifyTimestamp(ts, () => {
      called = true;
      return true;
    });
    expect(called).toBe(true);
  });
});

describe("anchored evidence bundle (records + rfc3161 anchor over the head)", () => {
  type Bundle = {
    records: { seal: { contentHash: string } }[];
    anchors: TrustedTimestamp[];
  };
  const bundle = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/bundle-ecdsa-p256-rfc3161-anchored.json", import.meta.url)),
      "utf8",
    ),
  ) as Bundle;

  it("the rfc3161 anchor covers the bundle's head and verifies offline", () => {
    const headHash = bundle.records[bundle.records.length - 1]!.seal.contentHash;
    const anchor = bundle.anchors[0]!;
    expect(anchor.provider).toBe("rfc3161");
    expect(anchor.hash).toBe(headHash);
    // rfc3161 anchors self-verify — the local keyset verifier is unused.
    expect(verifyTimestamp(anchor, () => false)).toBe(true);
  });
});
