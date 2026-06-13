const BASE = process.env.PHAROS_API_BASE ?? "http://localhost:4000";

/** Thin server-side client for the Pharos API. Tolerates an unreachable API. */
export async function api<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: T };
    return body.data;
  } catch {
    return null;
  }
}

export const DEMO_TENANT = "demo-tenant";
