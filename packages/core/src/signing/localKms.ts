import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from "node:crypto";
import {
  type SigningProvider,
  type PublicKeyEntry,
  makeKeyId,
  parseKeyId,
} from "./provider.js";
import { type KeystoreBackend, type StoredKey } from "./keystore.js";

/**
 * A simulated KMS: generates and stores Ed25519 keypairs in a keystore backend and
 * exposes only sign/verify/public-key operations. Behaviourally compatible with a
 * real KMS so that production can swap to AWS KMS by configuration. Key material is
 * confined to the keystore (the HSM boundary), never to evidence or operational state.
 */
export class LocalKms implements SigningProvider {
  readonly providerId = "local-kms";

  constructor(private readonly keystore: KeystoreBackend) {}

  private async versionsOf(keyName: string): Promise<number[]> {
    const all = await this.keystore.list();
    const versions: number[] = [];
    for (const k of all) {
      try {
        const parsed = parseKeyId(k.keyId);
        if (parsed.keyName === keyName) versions.push(parsed.version);
      } catch {
        // ignore malformed entries
      }
    }
    return versions.sort((a, b) => a - b);
  }

  private generate(keyId: string): StoredKey {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
      keyId,
      privateKeyDer: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      publicKeyDer: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    };
  }

  async ensureKey(keyName: string): Promise<string> {
    const versions = await this.versionsOf(keyName);
    if (versions.length > 0) return makeKeyId(keyName, versions[versions.length - 1]!);
    const keyId = makeKeyId(keyName, 1);
    await this.keystore.put(this.generate(keyId));
    return keyId;
  }

  async rotate(keyName: string): Promise<string> {
    const versions = await this.versionsOf(keyName);
    const next = (versions[versions.length - 1] ?? 0) + 1;
    const keyId = makeKeyId(keyName, next);
    await this.keystore.put(this.generate(keyId));
    return keyId;
  }

  async activeKeyId(keyName: string): Promise<string> {
    return this.ensureKey(keyName);
  }

  async sign(keyId: string, message: Buffer): Promise<string> {
    const stored = await this.keystore.get(keyId);
    if (!stored) throw new Error(`No such signing key: ${keyId}`);
    const privateKey = createPrivateKey({
      key: Buffer.from(stored.privateKeyDer, "base64"),
      format: "der",
      type: "pkcs8",
    });
    // Ed25519: algorithm must be null.
    return edSign(null, message, privateKey).toString("base64");
  }

  async verify(keyId: string, message: Buffer, signature: string): Promise<boolean> {
    const entry = await this.getPublicKey(keyId);
    if (!entry) return false;
    const publicKey = createPublicKey({
      key: Buffer.from(entry.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return edVerify(null, message, publicKey, Buffer.from(signature, "base64"));
  }

  async getPublicKey(keyId: string): Promise<PublicKeyEntry | null> {
    const stored = await this.keystore.get(keyId);
    if (!stored) return null;
    return { keyId, publicKey: stored.publicKeyDer, algorithm: "ed25519" };
  }

  async publishKeyset(): Promise<PublicKeyEntry[]> {
    const all = await this.keystore.list();
    return all.map((k) => ({ keyId: k.keyId, publicKey: k.publicKeyDer, algorithm: "ed25519" as const }));
  }
}
