import { AwsKms } from "./awsKms.js";
import { FileKeystore } from "./keystore.js";
import { LocalKms } from "./localKms.js";
import { registerSigningProvider } from "./registry.js";

/**
 * The signing backends that ship with Pharos, registered under the names the configuration
 * selects them by. `RemoteKms` (Vault Transit, Azure Key Vault, GCP KMS) is deliberately not
 * registered here: it needs a deployment-supplied transport, so a deployment registers it
 * with the transport closed over — see `docs/runbooks/key-rotation.md`.
 */

/** Ed25519 keys in a passphrase-encrypted on-disk keystore. Development and evaluation. */
registerSigningProvider("local-kms", ({ settings, namespace }) => {
  if (!settings.keystorePassphrase) {
    throw new Error(`local-kms (${namespace}) requires an encrypted-keystore passphrase`);
  }
  const dir =
    namespace === "signing" ? settings.keystoreDir : `${settings.keystoreDir}-${namespace}`;
  return new LocalKms(new FileKeystore(dir, settings.keystorePassphrase));
});

/**
 * The KMS alias prefix a namespace's keys live under: `pharos` for the evidence chain,
 * `pharos-tsa` for the local TSA. Operators pre-provision CMKs at these aliases
 * (`deploy/INSTALL.md`), so the derivation is exported and pinned by a test.
 */
export function awsKmsAliasPrefix(namespace: string): string {
  return namespace === "signing" ? "pharos" : `pharos-${namespace}`;
}

/** AWS KMS asymmetric keys (ECC_NIST_P256 / ECDSA_SHA_256), one CMK per tenant key name. */
registerSigningProvider("aws-kms", ({ settings, namespace }) => {
  return new AwsKms({
    region: settings.awsRegion ?? "us-east-1",
    endpoint: settings.awsEndpoint,
    aliasPrefix: awsKmsAliasPrefix(namespace),
    allowKeyCreation: settings.awsAllowKeyCreation ?? false,
  });
});
