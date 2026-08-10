import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

/**
 * Keystore backend for the simulated local KMS.
 *
 * This represents the HSM boundary, not platform/evidence state: it stores key
 * material for the local-kms provider only. In production this is replaced by a
 * real KMS (AWS KMS / CloudHSM) and no key material is persisted by Pharos at all.
 */
export interface StoredKey {
  keyId: string;
  privateKeyDer: string; // base64 PKCS8
  publicKeyDer: string; // base64 SPKI
}

export interface KeystoreBackend {
  put(key: StoredKey): Promise<void>;
  get(keyId: string): Promise<StoredKey | null>;
  list(): Promise<StoredKey[]>;
}

interface EncryptedKeyEnvelope {
  schemaVersion: 1;
  keyId: string;
  kdf: { name: "scrypt"; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; authTag: string; ciphertext: string };
}

const scrypt = promisify(scryptCallback);
const AAD_PREFIX = "pharos:file-keystore:v1:";
const FILE_SUFFIX = ".key.json";

function isStoredKey(value: unknown): value is StoredKey {
  if (!value || typeof value !== "object") return false;
  const key = value as Partial<StoredKey>;
  return (
    typeof key.keyId === "string" &&
    typeof key.privateKeyDer === "string" &&
    typeof key.publicKeyDer === "string"
  );
}

function isEnvelope(value: unknown): value is EncryptedKeyEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<EncryptedKeyEnvelope>;
  return (
    envelope.schemaVersion === 1 &&
    typeof envelope.keyId === "string" &&
    envelope.kdf?.name === "scrypt" &&
    typeof envelope.kdf.salt === "string" &&
    envelope.cipher?.name === "aes-256-gcm" &&
    typeof envelope.cipher.iv === "string" &&
    typeof envelope.cipher.authTag === "string" &&
    typeof envelope.cipher.ciphertext === "string"
  );
}

/**
 * Filesystem-backed, passphrase-encrypted development keystore (one JSON envelope per key).
 * Existing plaintext `StoredKey` files are encrypted atomically on first successful read.
 */
export class FileKeystore implements KeystoreBackend {
  /** A process already holds the passphrase; cache its expensive per-entry KDF results. */
  private readonly derivedKeys = new Map<string, Buffer>();

  constructor(
    private readonly dir: string,
    private readonly passphrase: string,
  ) {
    if (passphrase.length < 16) {
      throw new Error("FileKeystore passphrase must contain at least 16 characters");
    }
  }

  private fileFor(keyId: string): string {
    // keyId may contain '#'; encode to a filesystem-safe name.
    return join(this.dir, `${encodeURIComponent(keyId)}${FILE_SUFFIX}`);
  }

  private async secureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is filtered by umask and does not repair an existing permissive directory.
    await chmod(this.dir, 0o700);
  }

  private async deriveKey(salt: Buffer): Promise<Buffer> {
    const cacheKey = salt.toString("base64");
    const cached = this.derivedKeys.get(cacheKey);
    if (cached) return cached;
    const derived = (await scrypt(this.passphrase, salt, 32)) as Buffer;
    this.derivedKeys.set(cacheKey, derived);
    return derived;
  }

  private async encrypt(key: StoredKey): Promise<EncryptedKeyEnvelope> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const derived = await this.deriveKey(salt);
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(Buffer.from(`${AAD_PREFIX}${key.keyId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(key), "utf8"), cipher.final()]);
    return {
      schemaVersion: 1,
      keyId: key.keyId,
      kdf: { name: "scrypt", salt: salt.toString("base64") },
      cipher: {
        name: "aes-256-gcm",
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
    };
  }

  private async decrypt(envelope: EncryptedKeyEnvelope): Promise<StoredKey> {
    try {
      const derived = await this.deriveKey(Buffer.from(envelope.kdf.salt, "base64"));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        derived,
        Buffer.from(envelope.cipher.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(`${AAD_PREFIX}${envelope.keyId}`, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.cipher.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.cipher.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const key: unknown = JSON.parse(plaintext);
      if (!isStoredKey(key) || key.keyId !== envelope.keyId) throw new Error("invalid key payload");
      return key;
    } catch {
      throw new Error(
        `FileKeystore could not authenticate ${envelope.keyId}; ` +
          "the passphrase is wrong or the encrypted file was modified",
      );
    }
  }

  private async writeEncrypted(key: StoredKey): Promise<void> {
    await this.secureDir();
    const target = this.fileFor(key.keyId);
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let renamed = false;
    try {
      await writeFile(temporary, JSON.stringify(await this.encrypt(key)), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      renamed = true;
      await chmod(target, 0o600);
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  private async readEntry(file: string, expectedKeyId: string): Promise<StoredKey> {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isEnvelope(parsed)) {
      if (parsed.keyId !== expectedKeyId) {
        throw new Error(`FileKeystore key identity mismatch: ${parsed.keyId} != ${expectedKeyId}`);
      }
      return this.decrypt(parsed);
    }
    if (isStoredKey(parsed) && parsed.keyId === expectedKeyId) {
      // One-way compatibility migration from the former plaintext PKCS8 JSON format.
      await this.writeEncrypted(parsed);
      return parsed;
    }
    throw new Error(`FileKeystore found an invalid key envelope for ${expectedKeyId}`);
  }

  async put(key: StoredKey): Promise<void> {
    await this.writeEncrypted(key);
  }

  async get(keyId: string): Promise<StoredKey | null> {
    await this.secureDir();
    try {
      return await this.readEntry(this.fileFor(keyId), keyId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(): Promise<StoredKey[]> {
    await this.secureDir();
    const files = await readdir(this.dir);
    const out: StoredKey[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith(FILE_SUFFIX)) continue;
      const encodedKeyId = file.slice(0, -FILE_SUFFIX.length);
      let keyId: string;
      try {
        keyId = decodeURIComponent(encodedKeyId);
      } catch {
        throw new Error(`FileKeystore found an invalid key filename: ${file}`);
      }
      out.push(await this.readEntry(join(this.dir, file), keyId));
    }
    return out;
  }
}
