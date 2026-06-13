import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeystore, LocalKms, parseKeyId, signingMessage } from "@pharos/core";

describe("LocalKms signing + rotation", () => {
  let dir: string;
  let kms: LocalKms;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pharos-kms-"));
    kms = new LocalKms(new FileKeystore(dir));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ensureKey is idempotent and returns v1", async () => {
    const a = await kms.ensureKey("env:test");
    const b = await kms.ensureKey("env:test");
    expect(a).toBe(b);
    expect(parseKeyId(a)).toEqual({ keyName: "env:test", version: 1 });
  });

  it("signs and verifies", async () => {
    const keyId = await kms.ensureKey("env:test");
    const msg = signingMessage("a".repeat(64));
    const sig = await kms.sign(keyId, msg);
    expect(await kms.verify(keyId, msg, sig)).toBe(true);
    expect(await kms.verify(keyId, signingMessage("b".repeat(64)), sig)).toBe(false);
  });

  it("rotation mints a new version while old keys still verify (chain continuity)", async () => {
    const v1 = await kms.ensureKey("env:test");
    const msg = signingMessage("c".repeat(64));
    const sigV1 = await kms.sign(v1, msg);

    const v2 = await kms.rotate("env:test");
    expect(v2).not.toBe(v1);
    expect(parseKeyId(v2).version).toBe(2);
    expect(await kms.activeKeyId("env:test")).toBe(v2);

    // The old signature is still verifiable with the old keyId.
    expect(await kms.verify(v1, msg, sigV1)).toBe(true);
    // New signatures use the new key.
    const sigV2 = await kms.sign(v2, msg);
    expect(await kms.verify(v2, msg, sigV2)).toBe(true);
  });

  it("published keyset includes all versions", async () => {
    const keyset = await kms.publishKeyset();
    const names = keyset.map((k) => k.keyId);
    expect(names).toContain("env:test#v1");
    expect(names).toContain("env:test#v2");
    for (const k of keyset) expect(k.algorithm).toBe("ed25519");
  });

  it("persists across keystore reopen (durable)", async () => {
    const reopened = new LocalKms(new FileKeystore(dir));
    const keyId = await reopened.activeKeyId("env:test");
    expect(keyId).toBe("env:test#v2");
    expect(await reopened.getPublicKey("env:test#v1")).not.toBeNull();
  });
});
