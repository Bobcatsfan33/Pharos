import {
  jwtVerify,
  decodeJwt,
  createRemoteJWKSet,
  createLocalJWKSet,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { type Principal } from "./principal.js";
import { type Role, isRole } from "./rbac.js";

/**
 * OIDC bearer-token verification for interactive users.
 *
 * Works against any standards-compliant IdP. Okta and Entra (the two reference IdPs the
 * milestone requires) are both OIDC providers and are configured identically — only the
 * issuer, audience, JWKS URI, and claim names differ. Tokens are verified against the
 * issuer's JWKS (signature, issuer, audience, expiry); the tenant and roles are read
 * from configured claims and mapped onto a Principal.
 */
export interface OidcIssuerConfig {
  issuer: string;
  audience: string;
  /** Remote JWKS endpoint (production). */
  jwksUri?: string;
  /** Inline JWKS (tests / static keys). One of jwksUri or jwks is required. */
  jwks?: JSONWebKeySet;
  claims: {
    tenant: string; // claim holding the tenant id, e.g. "pharos_tenant"
    roles: string; // claim holding a string[] of roles, e.g. "pharos_roles"
    displayName?: string;
  };
}

export class OidcVerifier {
  private readonly issuers = new Map<string, { cfg: OidcIssuerConfig; getKey: JWTVerifyGetKey }>();

  constructor(configs: OidcIssuerConfig[]) {
    for (const cfg of configs) {
      const getKey = cfg.jwks
        ? createLocalJWKSet(cfg.jwks)
        : cfg.jwksUri
          ? createRemoteJWKSet(new URL(cfg.jwksUri))
          : (() => {
              throw new Error(`OIDC issuer ${cfg.issuer} needs jwksUri or jwks`);
            })();
      this.issuers.set(cfg.issuer, { cfg, getKey });
    }
  }

  /** Verify a bearer token and produce a Principal. Throws on any validation failure. */
  async verifyBearer(token: string): Promise<Principal> {
    let unverifiedIssuer: string | undefined;
    try {
      unverifiedIssuer = decodeJwt(token).iss;
    } catch {
      throw new Error("malformed bearer token");
    }
    if (!unverifiedIssuer) throw new Error("token missing issuer");
    const entry = this.issuers.get(unverifiedIssuer);
    if (!entry) throw new Error(`untrusted issuer: ${unverifiedIssuer}`);

    const { payload } = await jwtVerify(token, entry.getKey, {
      issuer: entry.cfg.issuer,
      audience: entry.cfg.audience,
    });

    const tenantId = payload[entry.cfg.claims.tenant];
    if (typeof tenantId !== "string" || !tenantId) {
      throw new Error(`token missing tenant claim ${entry.cfg.claims.tenant}`);
    }
    const rawRoles = payload[entry.cfg.claims.roles];
    const roles: Role[] = Array.isArray(rawRoles) ? rawRoles.filter((r): r is Role => typeof r === "string" && isRole(r)) : [];

    const displayClaim = entry.cfg.claims.displayName ? payload[entry.cfg.claims.displayName] : undefined;

    return {
      subject: String(payload.sub),
      tenantId,
      kind: "user",
      roles,
      scopes: [],
      displayName: typeof displayClaim === "string" ? displayClaim : undefined,
      issuer: entry.cfg.issuer,
    };
  }
}
