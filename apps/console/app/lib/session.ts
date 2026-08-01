import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { OidcVerifier, type OidcIssuerConfig, type Principal } from "@pharos/identity";

/**
 * Console session (#79).
 *
 * The console does NOT implement its own authentication. It verifies the *same* OIDC
 * bearer token the API accepts, using the *same* `OidcVerifier` from `@pharos/identity`,
 * against the same trusted issuers. There is no console user store, no console password,
 * and no console-issued token — a parallel auth system would be a second thing to get
 * wrong and a second place for tenancy to drift.
 *
 * How the token arrives: an identity-aware proxy or the TLS terminator the host already
 * owns (#76) authenticates the human and forwards the token, either as the
 * `pharos_session` cookie or an `Authorization: Bearer` header. The console never trusts
 * that hop — it re-verifies the signature, issuer, audience, and expiry itself, so a
 * forged or expired token gets nothing even if it reaches the app.
 *
 * The tenant comes from the verified token claim, never from configuration. That is what
 * replaces the `demo-tenant` hardwire: a viewer sees their own tenant's evidence because
 * their IdP said so, and cannot reach another tenant's by editing a URL.
 */
export const SESSION_COOKIE = "pharos_session";

/** Trusted issuers, shared with the API via the same env contract. */
function issuers(): OidcIssuerConfig[] {
  const raw = process.env.PHAROS_OIDC_ISSUERS;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OidcIssuerConfig[]) : [];
  } catch {
    // Malformed issuer config yields NO trusted issuers, so every request fails closed.
    // Falling back to "trust everything" here would be the worst possible default.
    return [];
  }
}

let cached: { key: string; verifier: OidcVerifier } | null = null;
function verifier(): OidcVerifier | null {
  const configs = issuers();
  if (configs.length === 0) return null;
  const key = JSON.stringify(configs.map((c) => c.issuer));
  if (!cached || cached.key !== key) {
    cached = { key, verifier: new OidcVerifier(configs) };
  }
  return cached.verifier;
}

async function presentedToken(): Promise<string | null> {
  const cookieToken = (await cookies()).get(SESSION_COOKIE)?.value;
  if (cookieToken) return cookieToken;
  const authorization = (await headers()).get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return null;
}

export interface ConsoleSession {
  /** Verified principal — tenant and roles come from the token, never from config. */
  principal: Principal;
  /**
   * The verified token, forwarded to the API so the SERVER re-authorizes every read.
   * The console's tenant scoping then only builds URLs; it is not the security boundary.
   */
  token: string;
}

/**
 * The verified session for this request, or null.
 *
 * Returns null — never a partially-trusted stand-in — when there is no token, no trusted
 * issuer configured, or verification fails for any reason.
 */
export async function getSession(): Promise<ConsoleSession | null> {
  const token = await presentedToken();
  if (!token) return null;
  const oidc = verifier();
  if (!oidc) return null;
  try {
    return { principal: await oidc.verifyBearer(token), token };
  } catch {
    // Signature, issuer, audience, expiry, or tenant-claim failure. No detail is
    // surfaced to the browser: a verification oracle is a gift to an attacker.
    return null;
  }
}

/**
 * Require a session before rendering evidence. Redirects to the sign-in notice otherwise.
 *
 * Every page that reads tenant data calls this FIRST, before any API call, so an
 * unauthenticated request cannot cause evidence to be fetched, let alone rendered.
 */
export async function requireSession(): Promise<ConsoleSession> {
  const session = await getSession();
  if (!session) redirect("/signin");
  return session;
}
