import type { PublicKeyEntry, SigningProvider } from "./provider.js";

export type RemoteKmsProvider = "vault-transit" | "azure-key-vault" | "gcp-kms";

export interface RemoteSignerTransport {
  ensureKey(request: { namespace: string; keyName: string }): Promise<string>;
  rotate(request: { namespace: string; keyName: string }): Promise<string>;
  activeKeyId(request: { namespace: string; keyName: string }): Promise<string>;
  sign(request: { namespace: string; keyId: string; messageBase64: string }): Promise<string>;
  verify(request: {
    namespace: string;
    keyId: string;
    messageBase64: string;
    signature: string;
  }): Promise<boolean>;
  getPublicKey(request: { namespace: string; keyId: string }): Promise<PublicKeyEntry | null>;
  publishKeyset(request: { namespace: string }): Promise<PublicKeyEntry[]>;
}

/**
 * Portable BYOK/HYOK adapter. Cloud authentication and network transport stay outside
 * Pharos; the injected transport can use workload identity, private endpoints, or an
 * air-gapped Vault proxy without exposing private key material to this process.
 */
export class RemoteKms implements SigningProvider {
  readonly providerId: RemoteKmsProvider;

  constructor(
    providerId: RemoteKmsProvider,
    private readonly namespace: string,
    private readonly transport: RemoteSignerTransport,
  ) {
    if (!namespace.trim()) throw new Error("remote KMS namespace is required");
    this.providerId = providerId;
  }

  ensureKey(keyName: string): Promise<string> {
    return this.transport.ensureKey({ namespace: this.namespace, keyName });
  }
  rotate(keyName: string): Promise<string> {
    return this.transport.rotate({ namespace: this.namespace, keyName });
  }
  activeKeyId(keyName: string): Promise<string> {
    return this.transport.activeKeyId({ namespace: this.namespace, keyName });
  }
  sign(keyId: string, message: Buffer): Promise<string> {
    return this.transport.sign({
      namespace: this.namespace,
      keyId,
      messageBase64: message.toString("base64"),
    });
  }
  verify(keyId: string, message: Buffer, signature: string): Promise<boolean> {
    return this.transport.verify({
      namespace: this.namespace,
      keyId,
      messageBase64: message.toString("base64"),
      signature,
    });
  }
  getPublicKey(keyId: string): Promise<PublicKeyEntry | null> {
    return this.transport.getPublicKey({ namespace: this.namespace, keyId });
  }
  publishKeyset(): Promise<PublicKeyEntry[]> {
    return this.transport.publishKeyset({ namespace: this.namespace });
  }
}
