import { LocalTsa, Rfc3161Tsa } from "../timestamp.js";
import { registerTsaProvider } from "./registry.js";

/** The trusted-time backends that ship with Pharos. */

/** Simulated TSA signing with an independent local keystore. Hermetic development only. */
registerTsaProvider("local", ({ env, localSigner }) => {
  const signer = localSigner();
  return { tsa: new LocalTsa(signer, `tsa-${env}`), keyset: () => signer.publishKeyset() };
});

/** Dev default endpoint when `rfc3161` is selected without a URL (FreeTSA). */
export const DEFAULT_FREETSA_URL = "https://freetsa.org/tsr";

/** A real RFC 3161 TSA; tokens are verified offline against an approved certificate pin. */
registerTsaProvider("rfc3161", ({ settings }) => ({
  tsa: new Rfc3161Tsa(settings.url ?? DEFAULT_FREETSA_URL, {
    trustPolicy: { trustedCertSha256: [...settings.trustedCertSha256] },
  }),
  keyset: async () => [],
}));
