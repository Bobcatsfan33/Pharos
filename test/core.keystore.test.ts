import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeystore, type StoredKey } from "@pharos/core";

const PASSPHRASE = "pharos-test-keystore-passphrase";
const KEY: StoredKey = {
  keyId: "tenant:encrypted#v1",
  privateKeyDer: Buffer.from("private-key-material").toString("base64"),
  publicKeyDer: Buffer.from("public-key-material").toString("base64"),
};

describe("FileKeystore encryption and filesystem posture", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pharos-encrypted-keystore-"));
    file = join(dir, `${encodeURIComponent(KEY.keyId)}.key.json`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("encrypts private keys, authenticates identity, and repairs directory/file modes", async () => {
    await chmod(dir, 0o777);
    const store = new FileKeystore(dir, PASSPHRASE);
    await store.put(KEY);

    const raw = await readFile(file, "utf8");
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.keyId).toBe(KEY.keyId);
    expect(raw).not.toContain(KEY.privateKeyDer);
    expect(raw).not.toContain("privateKeyDer");
    expect(await store.list()).toEqual([KEY]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("fails authentication with a wrong passphrase or modified ciphertext", async () => {
    const store = new FileKeystore(dir, PASSPHRASE);
    await store.put(KEY);
    await expect(new FileKeystore(dir, "different-test-passphrase").get(KEY.keyId)).rejects.toThrow(
      /wrong or.*modified/i,
    );

    const envelope = JSON.parse(await readFile(file, "utf8")) as {
      cipher: { ciphertext: string };
    };
    const replacement = envelope.cipher.ciphertext.startsWith("A") ? "B" : "A";
    envelope.cipher.ciphertext = replacement + envelope.cipher.ciphertext.slice(1);
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.get(KEY.keyId)).rejects.toThrow(/wrong or.*modified/i);
  });

  it("atomically migrates a legacy plaintext key on first read", async () => {
    await chmod(dir, 0o777);
    await writeFile(file, JSON.stringify(KEY), { mode: 0o644 });
    const store = new FileKeystore(dir, PASSPHRASE);

    expect(await store.list()).toEqual([KEY]);
    const migrated = await readFile(file, "utf8");
    expect(migrated).not.toContain(KEY.privateKeyDer);
    expect(JSON.parse(migrated).schemaVersion).toBe(1);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("rejects weak passphrases before touching the filesystem", () => {
    expect(() => new FileKeystore(dir, "too-short")).toThrow(/at least 16/i);
  });
});
