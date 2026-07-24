import {
  KMSClient,
  CreateKeyCommand,
  CreateAliasCommand,
  ListAliasesCommand,
  GetPublicKeyCommand,
  SignCommand,
} from "@aws-sdk/client-kms";
import { verify as nodeVerify, createPublicKey } from "node:crypto";
import { type SigningProvider, type PublicKeyEntry, makeKeyId, parseKeyId } from "./provider.js";

/**
 * AWS KMS signing provider.
 *
 * Implements the same {@link SigningProvider} contract as the local KMS, backed by AWS KMS
 * asymmetric keys. AWS KMS does not offer Ed25519, so keys are `ECC_NIST_P256` signed with
 * `ECDSA_SHA_256`; published keys therefore carry `algorithm: "ecdsa-p256"` and a keyset can
 * mix both algorithms across a provider switch (see chain/verify.ts).
 *
 * Private key material never leaves KMS. The `<name>#v<n>` keyId scheme is preserved by
 * mapping every version onto its own KMS alias, `alias/<prefix>/<b64url(name)>/v<n>`:
 *
 *   - one KMS key per version; `rotate()` mints a new key + a new `.../v<n+1>` alias.
 *   - **old versions keep their own alias and stay enabled for verify** — chain continuity
 *     across rotations (each record embeds the keyId that signed it).
 *   - the provider is stateless: version discovery is `ListAliases`, so nothing is persisted
 *     by Pharos.
 *
 * keyNames may contain characters KMS alias names disallow (e.g. `:`), so the name is
 * base64url-encoded into the alias and decoded back in `publishKeyset()`.
 */
export interface AwsKmsConfig {
  region: string;
  /** Endpoint override for a KMS emulator (dev/CI). Omit for real AWS. */
  endpoint?: string;
  /**
   * Alias namespace: keys live under `alias/<aliasPrefix>/…`. Defaults to `"pharos"`.
   * The TSA uses a separate prefix so its keyset is isolated from the signing keyset.
   */
  aliasPrefix?: string;
}

function encodeName(keyName: string): string {
  return Buffer.from(keyName, "utf8").toString("base64url");
}
function decodeName(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

export class AwsKms implements SigningProvider {
  readonly providerId = "aws-kms";
  private readonly client: KMSClient;
  private readonly aliasPrefix: string;
  /** Public keys are immutable per keyId; cache to avoid repeat GetPublicKey calls. */
  private readonly publicKeyCache = new Map<string, PublicKeyEntry>();

  constructor(cfg: AwsKmsConfig) {
    this.aliasPrefix = cfg.aliasPrefix ?? "pharos";
    this.client = new KMSClient({
      region: cfg.region,
      // With an endpoint set we are talking to a KMS emulator (dev/CI): supply dummy static
      // credentials so the SDK doesn't require a real credential chain. Against real AWS
      // (no endpoint) the SDK's default credential provider chain (env/role/SSO) is used.
      ...(cfg.endpoint
        ? {
            endpoint: cfg.endpoint,
            credentials: { accessKeyId: "local-kms", secretAccessKey: "local-kms" },
          }
        : {}),
    });
  }

  private aliasPrefixPath(): string {
    return `alias/${this.aliasPrefix}/`;
  }
  private aliasName(keyName: string, version: number): string {
    return `${this.aliasPrefixPath()}${encodeName(keyName)}/v${version}`;
  }

  /** All existing versions for a keyName, ascending, discovered from KMS aliases. */
  private async versionsOf(keyName: string): Promise<number[]> {
    const prefix = `${this.aliasPrefixPath()}${encodeName(keyName)}/v`;
    const versions: number[] = [];
    for (const alias of await this.listAliasNames()) {
      if (alias.startsWith(prefix)) {
        const v = Number(alias.slice(prefix.length));
        if (Number.isInteger(v)) versions.push(v);
      }
    }
    return versions.sort((a, b) => a - b);
  }

  private async listAliasNames(): Promise<string[]> {
    const names: string[] = [];
    let marker: string | undefined;
    do {
      const res = await this.client.send(new ListAliasesCommand({ Marker: marker, Limit: 100 }));
      for (const a of res.Aliases ?? []) if (a.AliasName) names.push(a.AliasName);
      marker = res.Truncated ? res.NextMarker : undefined;
    } while (marker);
    return names;
  }

  private async createVersion(keyName: string, version: number): Promise<string> {
    const key = await this.client.send(
      new CreateKeyCommand({
        KeySpec: "ECC_NIST_P256",
        KeyUsage: "SIGN_VERIFY",
        Description: `Pharos ${this.aliasPrefix} signing key ${keyName} v${version}`,
      }),
    );
    const kmsKeyId = key.KeyMetadata?.KeyId;
    if (!kmsKeyId) throw new Error("AWS KMS CreateKey returned no KeyId");
    // One alias per version so older versions remain individually addressable for verify.
    await this.client.send(
      new CreateAliasCommand({
        AliasName: this.aliasName(keyName, version),
        TargetKeyId: kmsKeyId,
      }),
    );
    return makeKeyId(keyName, version);
  }

  async ensureKey(keyName: string): Promise<string> {
    const versions = await this.versionsOf(keyName);
    if (versions.length > 0) return makeKeyId(keyName, versions[versions.length - 1]!);
    return this.createVersion(keyName, 1);
  }

  async rotate(keyName: string): Promise<string> {
    const versions = await this.versionsOf(keyName);
    const next = (versions[versions.length - 1] ?? 0) + 1;
    return this.createVersion(keyName, next);
  }

  /**
   * Migration helper: provision a new KMS key for `keyName` at an EXPLICIT version, so an
   * aws-kms provider can continue a keyId version sequence that began under a different provider
   * (e.g. local-kms `<name>#v1` → aws-kms `<name>#v2`) without a keyId collision. keyIds must be
   * globally unique, so this is how a provider switch preserves "no data migration" (old records
   * keep verifying under their old keyId; new records sign under the next version). Not part of
   * the SigningProvider interface — a provider-specific, one-time operational step. Throws if the
   * version already exists.
   */
  async provisionVersion(keyName: string, version: number): Promise<string> {
    if ((await this.versionsOf(keyName)).includes(version)) {
      throw new Error(`aws-kms: version ${version} already exists for ${keyName}`);
    }
    return this.createVersion(keyName, version);
  }

  async activeKeyId(keyName: string): Promise<string> {
    return this.ensureKey(keyName);
  }

  private aliasFor(keyId: string): string {
    const { keyName, version } = parseKeyId(keyId);
    return this.aliasName(keyName, version);
  }

  async sign(keyId: string, message: Buffer): Promise<string> {
    const res = await this.client.send(
      new SignCommand({
        KeyId: this.aliasFor(keyId),
        Message: message,
        MessageType: "RAW", // KMS computes SHA-256 of the message (bounded: our messages are tiny)
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!res.Signature) throw new Error(`AWS KMS Sign returned no signature for ${keyId}`);
    return Buffer.from(res.Signature).toString("base64");
  }

  async verify(keyId: string, message: Buffer, signature: string): Promise<boolean> {
    // Verify offline against the public key (no KMS round-trip), the same path an external
    // verifier uses. AWS KMS Verify would also work but is a needless network call.
    const entry = await this.getPublicKey(keyId);
    if (!entry) return false;
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(entry.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      return nodeVerify("sha256", message, publicKey, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }

  async getPublicKey(keyId: string): Promise<PublicKeyEntry | null> {
    const cached = this.publicKeyCache.get(keyId);
    if (cached) return cached;
    try {
      const res = await this.client.send(new GetPublicKeyCommand({ KeyId: this.aliasFor(keyId) }));
      if (!res.PublicKey) return null;
      const entry: PublicKeyEntry = {
        keyId,
        publicKey: Buffer.from(res.PublicKey).toString("base64"),
        algorithm: "ecdsa-p256",
      };
      this.publicKeyCache.set(keyId, entry);
      return entry;
    } catch (err) {
      if ((err as { name?: string }).name === "NotFoundException") return null;
      throw err;
    }
  }

  async publishKeyset(): Promise<PublicKeyEntry[]> {
    const prefix = this.aliasPrefixPath();
    const keyIds: string[] = [];
    for (const alias of await this.listAliasNames()) {
      if (!alias.startsWith(prefix)) continue;
      // alias/<prefix>/<b64url(name)>/v<n>  (b64url contains no '/')
      const m = alias.slice(prefix.length).match(/^([A-Za-z0-9_-]+)\/v(\d+)$/);
      if (m) keyIds.push(makeKeyId(decodeName(m[1]!), Number(m[2])));
    }
    const out: PublicKeyEntry[] = [];
    for (const keyId of keyIds) {
      const entry = await this.getPublicKey(keyId);
      if (entry) out.push(entry);
    }
    return out;
  }
}
