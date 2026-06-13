import pg from "pg";

const { Pool } = pg;

export function createPool(url: string): pg.Pool {
  return new Pool({ connectionString: url, max: 20, idleTimeoutMillis: 30_000 });
}

export type { Pool } from "pg";
