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
 *
 * **Key provisioning is explicit.** The alias above is the operator-facing identifier: a key
 * must already exist at it, or {@link AwsKmsConfig.allowKeyCreation} must be set. `ensureKey()`
 * does not silently mint CMKs by default — see that option for why. The derivation is documented
 * for operators in `deploy/INSTALL.md` ("Provisioning signing keys") and pinned to this code by
 * `test/docs.kms-key-identifier.test.ts`.
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
  /**
   * Permit {@link AwsKms.ensureKey} to mint a CMK when a keyName has no key yet.
   *
   * **Defaults to `false` — first use fails closed.** A CMK created implicitly carries the AWS
   * *default key policy*, which is a materially weaker control than a key whose policy, grants,
   * tags, and region/replication the operator chose; and until an operator knows the alias this
   * provider derives, they cannot pre-provision one. Refusing by default makes the binding
   * explicit: either the key exists at the derived alias, or the operator has opted in here.
   *
   * This gates only the implicit first-use path. `rotate()` and `provisionVersion()` are
   * explicit operator actions by definition and remain available.
   */
  allowKeyCreation?: boolean;
}

function encodeName(keyName: string): string {
  return Buffer.from(keyName, "utf8").toString("base64url");
}
function decodeName(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

/**
 * The operator-facing identifier for a signing key: `alias/<prefix>/<base64url(keyName)>/v<n>`.
 *
 * Exported because operators must be able to pre-provision a customer-managed CMK at exactly
 * this name, so the derivation is a documented contract rather than an implementation detail.
 * `deploy/INSTALL.md` ("Provisioning signing keys") documents it and
 * `test/docs.kms-key-identifier.test.ts` pins the documentation to this function.
 */
export function awsKmsAliasName(aliasPrefix: string, keyName: string, version: number): string {
  return `alias/${aliasPrefix}/${encodeName(keyName)}/v${version}`;
}

export class AwsKms implements SigningProvider {
  readonly providerId = "aws-kms";
  private readonly client: KMSClient;
  private readonly aliasPrefix: string;
  private readonly allowKeyCreation: boolean;
  /** Public keys are immutable per keyId; cache to avoid repeat GetPublicKey calls. */
  private readonly publicKeyCache = new Map<string, PublicKeyEntry>();

  constructor(cfg: AwsKmsConfig) {
    this.aliasPrefix = cfg.aliasPrefix ?? "pharos";
    this.allowKeyCreation = cfg.allowKeyCreation ?? false;
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
    return awsKmsAliasName(this.aliasPrefix, keyName, version);
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
    // Collision guard on every creating path (ensureKey, rotate, provisionVersion). keyIds must
    // be globally unique — two different keys answering to one `<name>#v<n>` would silently break
    // the merged keyset a provider migration depends on. Checked before CreateKey so a refusal
    // does not strand an unaliased CMK in the operator's account.
    if ((await this.versionsOf(keyName)).includes(version)) {
      throw new Error(
        `aws-kms: version ${version} already exists for ${keyName} ` +
          `(${this.aliasName(keyName, version)}); refusing to mint a colliding key`,
      );
    }
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
    if (!this.allowKeyCreation) {
      // The message is the missing documentation: it names the exact alias to pre-provision and
      // the flag that would permit implicit creation, so an operator can resolve this without
      // reverse-engineering the alias derivation from source.
      throw new Error(
        `aws-kms: no signing key for "${keyName}" and implicit key creation is disabled. ` +
          `Pre-provision a customer-managed CMK (KeySpec ECC_NIST_P256, KeyUsage SIGN_VERIFY) ` +
          `and alias it "${this.aliasName(keyName, 1)}", granting this principal kms:Sign and ` +
          `kms:GetPublicKey — or set PHAROS_KMS_AWS_ALLOW_KEY_CREATION=true to let Pharos mint ` +
          `it under the AWS default key policy. See deploy/INSTALL.md "Provisioning signing keys".`,
      );
    }
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
