import { describe, it, expect } from "vitest";
import { generateApiKey, parseApiKey, verifySecret, hashSecret } from "@pharos/identity";

describe("API keys", () => {
  it("generates a parseable key whose secret is not the stored hash", () => {
    const k = generateApiKey();
    expect(k.plaintext.startsWith("pk_")).toBe(true);
    const parsed = parseApiKey(k.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyId).toBe(k.keyId);
    expect(parsed!.secret).toBe(k.secret);
    expect(k.secretHash).toBe(hashSecret(k.secret));
    expect(k.secretHash).not.toBe(k.secret);
  });

  it("verifies the right secret and rejects the wrong one", () => {
    const k = generateApiKey();
    expect(verifySecret(k.secret, k.secretHash)).toBe(true);
    expect(verifySecret("wrong", k.secretHash)).toBe(false);
  });

  it("rejects malformed keys", () => {
    expect(parseApiKey("not-a-key")).toBeNull();
    expect(parseApiKey("pk_only")).toBeNull();
    expect(parseApiKey("xx_a_b")).toBeNull();
  });

  it("generates unique keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.secret).not.toBe(b.secret);
  });
});
