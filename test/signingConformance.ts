import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  type SigningProvider,
  type SignatureAlgorithm,
  parseKeyId,
  signingMessageV2,
  keysetVerifier,
} from "@pharos/core";

/**
 * The SigningProvider conformance contract. Every provider (LocalKms, AwsKms, and any future
 * one) must satisfy exactly these behaviours, so a provider swap is transparent to the seal
 * and chain-verification paths. Run it against a provider with {@link runSigningConformance}.
 *
 * Each test uses a fresh random keyName so the suite is isolated across runs even against a
 * stateful emulator that retains keys for its lifetime.
 */
export function runSigningConformance(opts: {
  name: string;
  expectedAlgorithm: SignatureAlgorithm;
  /** Construct a provider. Called once per test; may return the same instance. */
  makeProvider: () => SigningProvider | Promise<SigningProvider>;
}): void {
  const { name, expectedAlgorithm, makeProvider } = opts;

  describe(`SigningProvider conformance — ${name}`, () => {
    const freshName = () => `conformance:${randomUUID()}`;
    const msg = (s: string) =>
      signingMessageV2({ contentHash: s, prevHash: "genesis", sequence: 0 });

    it("ensureKey is idempotent and returns v1", async () => {
      const kms = await makeProvider();
      const keyName = freshName();
      const a = await kms.ensureKey(keyName);
      const b = await kms.ensureKey(keyName);
      expect(a).toBe(b);
      expect(parseKeyId(a)).toEqual({ keyName, version: 1 });
    });

    it("signs and verifies; rejects a tampered message", async () => {
      const kms = await makeProvider();
      const keyId = await kms.ensureKey(freshName());
      const m = msg("a".repeat(64));
      const sig = await kms.sign(keyId, m);
      expect(await kms.verify(keyId, m, sig)).toBe(true);
      expect(await kms.verify(keyId, msg("b".repeat(64)), sig)).toBe(false);
    });

    it("rotation mints a new version; old versions still verify (chain continuity)", async () => {
      const kms = await makeProvider();
      const keyName = freshName();
      const v1 = await kms.ensureKey(keyName);
      const m = msg("c".repeat(64));
      const sigV1 = await kms.sign(v1, m);

      const v2 = await kms.rotate(keyName);
      expect(v2).not.toBe(v1);
      expect(parseKeyId(v2).version).toBe(2);
      expect(await kms.activeKeyId(keyName)).toBe(v2);

      // A signature made under the old key still verifies with the old keyId.
      expect(await kms.verify(v1, m, sigV1)).toBe(true);
      const sigV2 = await kms.sign(v2, m);
      expect(await kms.verify(v2, m, sigV2)).toBe(true);
    });

    it("getPublicKey and publishKeyset expose the correct algorithm and all versions", async () => {
      const kms = await makeProvider();
      const keyName = freshName();
      const v1 = await kms.ensureKey(keyName);
      const v2 = await kms.rotate(keyName);

      const e1 = await kms.getPublicKey(v1);
      expect(e1?.algorithm).toBe(expectedAlgorithm);
      expect(e1?.keyId).toBe(v1);

      const keyset = await kms.publishKeyset();
      const ids = keyset.map((k) => k.keyId);
      expect(ids).toContain(v1);
      expect(ids).toContain(v2);
      for (const k of keyset) expect(k.algorithm).toBe(expectedAlgorithm);
    });

    it("offline verification with the published keyset (the external-verifier path)", async () => {
      const kms = await makeProvider();
      const keyName = freshName();
      const keyId = await kms.ensureKey(keyName);
      const m = msg("d".repeat(64));
      const sig = await kms.sign(keyId, m);

      // A third party has only the published keyset (public keys) and the pure verifier.
      const verify = keysetVerifier(await kms.publishKeyset());
      expect(verify(keyId, m, sig)).toBe(true);
      expect(verify(keyId, msg("e".repeat(64)), sig)).toBe(false);
      expect(verify("unknown#v1", m, sig)).toBe(false);
    });
  });
}
