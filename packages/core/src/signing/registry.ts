import type { SigningProvider } from "./provider.js";

/**
 * Signing-provider registry.
 *
 * The composition root selects a signing backend by name (`PHAROS_KMS_PROVIDER`) and asks
 * this registry to build it. Adding a backend is one file that implements `SigningProvider`
 * plus one `registerSigningProvider` call; nothing central is edited.
 *
 * A factory receives the KMS settings and a *namespace*. Pharos builds two providers from
 * the same settings: the evidence signer (`namespace: "signing"`) and the independent key
 * space the simulated local TSA signs with (`namespace: "tsa"`). A provider must keep the
 * two namespaces' keys apart — separate keystore directories, alias prefixes, or key rings —
 * so anchors never trust the evidence keys.
 */
export interface KmsSettings {
  /** Local keystore directory (local-kms). */
  keystoreDir: string;
  /** Passphrase for the encrypted local keystore (local-kms). */
  keystorePassphrase?: string | undefined;
  /** AWS region (aws-kms). Credentials come from the standard AWS provider chain. */
  awsRegion?: string | undefined;
  /** Optional endpoint override for a KMS emulator (aws-kms, dev/CI). */
  awsEndpoint?: string | undefined;
  /** Permit aws-kms to mint a CMK on first use. */
  awsAllowKeyCreation?: boolean | undefined;
}

export interface SigningProviderContext {
  settings: KmsSettings;
  /** `"signing"` for the evidence chain, `"tsa"` for the local timestamp authority. */
  namespace: "signing" | "tsa" | (string & {});
}

export type SigningProviderFactory = (ctx: SigningProviderContext) => SigningProvider;

const factories = new Map<string, SigningProviderFactory>();

/** Register a signing backend under the name `PHAROS_KMS_PROVIDER` selects it by. */
export function registerSigningProvider(name: string, factory: SigningProviderFactory): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`signing provider name must be lower-case kebab-case, got "${name}"`);
  }
  factories.set(name, factory);
}

/** Build the named signing backend, or throw naming the backends that are registered. */
export function createSigningProvider(name: string, ctx: SigningProviderContext): SigningProvider {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(
      `unknown signing provider "${name}"; registered: ${listSigningProviders().join(", ")}`,
    );
  }
  return factory(ctx);
}

export function hasSigningProvider(name: string): boolean {
  return factories.has(name);
}

export function listSigningProviders(): string[] {
  return [...factories.keys()].sort();
}
