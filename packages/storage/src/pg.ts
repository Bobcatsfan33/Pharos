import type pg from "pg";

/**
 * Open a Postgres pool. The driver is imported lazily so a bundle that only runs the
 * embedded backend (the CLI) never loads `pg`; callers already await the migrations that
 * follow, so the async signature costs nothing.
 */
export async function createPool(url: string): Promise<pg.Pool> {
  const { default: driver } = await import("pg");
  return new driver.Pool({ connectionString: url, max: 20, idleTimeoutMillis: 30_000 });
}

export type { Pool } from "pg";
