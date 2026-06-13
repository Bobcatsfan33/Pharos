import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { OidcVerifier, type OidcIssuerConfig } from "@pharos/identity";

/**
 * Simulates two reference IdPs (Okta + Entra) as local JWKS issuers. Both are OIDC, so
 * the verifier configuration is identical apart from issuer/audience/claim names — which
 * is exactly how Okta and Entra differ in production.
 */
interface FakeIdp {
  issuer: string;
  audience: string;
  jwk: JWK;
  privateKey: CryptoKey;
  claims: OidcIssuerConfig["claims"];
}

async function makeIdp(issuer: string, audience: string, claims: OidcIssuerConfig["claims"]): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = `${issuer}-kid`;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { issuer, audience, jwk, privateKey, claims };
}

async function mintToken(idp: FakeIdp, payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: idp.jwk.kid })
    .setIssuer(idp.issuer)
    .setAudience(idp.audience)
    .setSubject(String(payload.sub ?? "user"))
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(idp.privateKey);
}

describe("OIDC verification (Okta + Entra)", () => {
  let okta: FakeIdp;
  let entra: FakeIdp;
  let verifier: OidcVerifier;

  beforeAll(async () => {
    okta = await makeIdp("https://acme.okta.com", "pharos", { tenant: "pharos_tenant", roles: "pharos_roles" });
    entra = await makeIdp("https://login.microsoftonline.com/acme", "api://pharos", {
      tenant: "tid",
      roles: "roles",
    });
    verifier = new OidcVerifier([
      { issuer: okta.issuer, audience: okta.audience, jwks: { keys: [okta.jwk] }, claims: okta.claims },
      { issuer: entra.issuer, audience: entra.audience, jwks: { keys: [entra.jwk] }, claims: entra.claims },
    ]);
  });

  it("verifies an Okta token and maps tenant + roles", async () => {
    const token = await mintToken(okta, { sub: "okta-user", pharos_tenant: "acme-bank", pharos_roles: ["reviewer"] });
    const principal = await verifier.verifyBearer(token);
    expect(principal.kind).toBe("user");
    expect(principal.tenantId).toBe("acme-bank");
    expect(principal.roles).toEqual(["reviewer"]);
    expect(principal.issuer).toBe(okta.issuer);
  });

  it("verifies an Entra token with different claim names", async () => {
    const token = await mintToken(entra, { sub: "entra-user", tid: "contoso", roles: ["tenant_admin", "bogus_role"] });
    const principal = await verifier.verifyBearer(token);
    expect(principal.tenantId).toBe("contoso");
    // Unknown roles are filtered out.
    expect(principal.roles).toEqual(["tenant_admin"]);
  });

  it("rejects a token from an untrusted issuer", async () => {
    const rogue = await makeIdp("https://evil.example.com", "pharos", { tenant: "pharos_tenant", roles: "pharos_roles" });
    const token = await mintToken(rogue, { sub: "x", pharos_tenant: "acme-bank", pharos_roles: ["tenant_admin"] });
    await expect(verifier.verifyBearer(token)).rejects.toThrow(/untrusted issuer/);
  });

  it("rejects a token signed by the wrong key (forgery)", async () => {
    // Mint with Entra's key but claim Okta's issuer → signature won't verify against Okta JWKS.
    const forged = await new SignJWT({ sub: "x", pharos_tenant: "acme-bank", pharos_roles: ["tenant_admin"] })
      .setProtectedHeader({ alg: "RS256", kid: okta.jwk.kid })
      .setIssuer(okta.issuer)
      .setAudience(okta.audience)
      .setSubject("x")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(entra.privateKey);
    await expect(verifier.verifyBearer(forged)).rejects.toThrow();
  });

  it("rejects a token missing the tenant claim", async () => {
    const token = await mintToken(okta, { sub: "okta-user", pharos_roles: ["reviewer"] });
    await expect(verifier.verifyBearer(token)).rejects.toThrow(/tenant claim/);
  });

  it("rejects a wrong-audience token", async () => {
    const token = await new SignJWT({ sub: "x", pharos_tenant: "acme-bank", pharos_roles: ["reviewer"] })
      .setProtectedHeader({ alg: "RS256", kid: okta.jwk.kid })
      .setIssuer(okta.issuer)
      .setAudience("some-other-api")
      .setSubject("x")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(okta.privateKey);
    await expect(verifier.verifyBearer(token)).rejects.toThrow();
  });
});
