const BASE = process.env.PHAROS_API_BASE ?? "http://localhost:4000";
// Evidence reads are authenticated; the console presents a read-scoped service key.
const CONSOLE_KEY = process.env.PHAROS_CONSOLE_API_KEY;

/** Thin server-side client for the Pharos API. Tolerates an unreachable API. */
export async function api<T>(path: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = {};
    if (CONSOLE_KEY) headers["x-api-key"] = CONSOLE_KEY;
    const res = await fetch(`${BASE}${path}`, { cache: "no-store", headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: T };
    return body.data;
  } catch {
    return null;
  }
}

export const DEMO_TENANT = "demo-tenant";
