import type { PublicKeyEntry, SigningProvider } from "@pharos/core";
import type { TsaProvider } from "../timestamp.js";

/**
 * Trusted-time authority registry.
 *
 * The composition root selects an anchoring backend by name (`PHAROS_TSA_PROVIDER`) and asks
 * this registry to build it. Adding a backend is one file that implements `TsaProvider` plus
 * one `registerTsaProvider` call.
 *
 * A factory returns the provider together with the public keyset an offline verifier needs
 * for its anchors: the simulated `local` TSA publishes the keys it signs with; a real RFC 3161
 * TSA publishes nothing, because its tokens carry their own certificate chain and are verified
 * against an independently supplied pin.
 */
export interface TsaSettings {
  /** TSA endpoint, for providers that have one. */
  url?: string | undefined;
  /** Independently approved leaf-certificate SHA-256 pins (RFC 3161). */
  trustedCertSha256: readonly string[];
  /** Scheduled anchoring interval (ms); 0 disables the scheduler. */
  intervalMs: number;
}

export interface TsaProviderContext {
  settings: TsaSettings;
  /** The deployment environment (`local`, `staging`, `prod`, …), for key naming. */
  env: string;
  /**
   * Builds the independent signer the simulated local TSA stamps with. Provided lazily so a
   * backend that does not sign locally never touches the signing registry.
   */
  localSigner: () => SigningProvider;
}

export interface TsaProviderBuild {
  tsa: TsaProvider;
  /** Published TSA public keys for offline anchor verification; `[]` when tokens self-verify. */
  keyset: () => Promise<PublicKeyEntry[]>;
}

export type TsaProviderFactory = (ctx: TsaProviderContext) => TsaProviderBuild;

const factories = new Map<string, TsaProviderFactory>();

/** Register a trusted-time backend under the name `PHAROS_TSA_PROVIDER` selects it by. */
export function registerTsaProvider(name: string, factory: TsaProviderFactory): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`TSA provider name must be lower-case kebab-case, got "${name}"`);
  }
  factories.set(name, factory);
}

/** Build the named trusted-time backend, or throw naming the backends that are registered. */
export function createTsaProvider(name: string, ctx: TsaProviderContext): TsaProviderBuild {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(`unknown TSA provider "${name}"; registered: ${listTsaProviders().join(", ")}`);
  }
  return factory(ctx);
}

export function hasTsaProvider(name: string): boolean {
  return factories.has(name);
}

export function listTsaProviders(): string[] {
  return [...factories.keys()].sort();
}
