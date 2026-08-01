import { getSession } from "../lib/session";
import { redirect } from "next/navigation";

/**
 * Sign-in notice (#79).
 *
 * Deliberately NOT a login form. The console does not authenticate anyone — it verifies
 * an OIDC token issued by the operator's own identity provider and forwarded by the
 * identity-aware proxy or TLS terminator that already fronts it (#76). Collecting
 * credentials here would mean building a second authentication system, a second place
 * for tenancy to drift, and a page that looks exactly like the phishing target an
 * evidence console must never resemble.
 *
 * So this page explains the contract and nothing else. It renders no tenant data.
 */
export default async function SignInPage() {
  // Already authenticated visitors have no business on this page.
  if (await getSession()) redirect("/");

  return (
    <div className="maxw-640">
      <h1 className="fs-24">Sign-in required</h1>
      <p className="c-muted">
        This console shows sealed evidence and is available only to an authenticated member of a
        tenant. No session was presented with this request.
      </p>
      <p className="c-muted">
        Pharos does not issue console credentials. Access is granted by your organisation&apos;s
        identity provider: the identity-aware proxy in front of this console signs you in and
        forwards your OIDC token as the <code>pharos_session</code> cookie, which the console
        verifies against the trusted issuers configured in <code>PHAROS_OIDC_ISSUERS</code>.
      </p>
      <p className="c-muted">
        If you reached this page after signing in, your token was rejected — it may have expired, or
        it may come from an issuer this deployment does not trust. Contact your platform operator;
        the console deliberately does not report which check failed.
      </p>
    </div>
  );
}
