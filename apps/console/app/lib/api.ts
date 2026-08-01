const BASE = process.env.PHAROS_API_BASE ?? "http://localhost:4000";

/**
 * Thin server-side client for the Pharos API. Tolerates an unreachable API.
 *
 * Reads are made **as the signed-in user** (#79): the caller passes the verified session
 * token and it goes upstream as a bearer credential, so the API's own `authorize()`
 * enforces tenant isolation on every request. The console's tenant scoping then only
 * decides which URL to build — it is not the security boundary, and a mistake there
 * cannot expose another tenant's evidence because the server would refuse it.
 *
 * There is deliberately no shared read-scoped service key any more. One console
 * credential able to read every tenant is what makes a console compromise unbounded.
 */
export async function api<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: T };
    return body.data;
  } catch {
    return null;
  }
}
