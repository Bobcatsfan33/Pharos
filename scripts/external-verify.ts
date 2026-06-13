/**
 * Standalone external verifier.
 *
 * This demonstrates the M0 exit criterion: a third party can validate a record (and
 * the whole chain) using ONLY the exported records and the published public keyset —
 * no Pharos infrastructure, no database, no trust in the platform.
 *
 * In a real audit the verifier would receive an evidence bundle (records JSON +
 * keyset JSON) out of band. Here we fetch them from the running API to keep the demo
 * self-contained, then verify entirely with @pharos/core's pure functions.
 *
 *   Usage: tsx scripts/external-verify.ts <tenantId> [apiBaseUrl]
 */
import { verifyChain, type ActionRecord, type PublicKeyEntry } from "../packages/core/src/index.js";

const tenantId = process.argv[2] ?? "demo-tenant";
const base = process.argv[3] ?? "http://localhost:4000";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  const body = (await res.json()) as { data: T };
  return body.data;
}

async function main(): Promise<void> {
  console.log(`\n=== External verification of tenant "${tenantId}" (offline, zero-trust) ===`);

  // Fetch the evidence bundle: records + published keyset.
  const { count } = await getJson<{ count: number }>(`/v1/chain/${tenantId}`);
  const records: ActionRecord[] = [];
  for (let seq = 0; seq < count; seq++) {
    records.push(await getJson<ActionRecord>(`/v1/records/${tenantId}/${seq}`));
  }
  const { keys } = await getJson<{ keys: PublicKeyEntry[] }>(`/v1/keyset`);

  console.log(`Fetched ${records.length} records and ${keys.length} public keys.`);
  console.log("Verifying with @pharos/core ONLY (no DB, no signer, no platform calls)…\n");

  // Pure verification — this is the documented procedure a third party follows.
  const report = verifyChain(records, keys);

  for (const r of report.records) {
    const mark = r.ok ? "✅" : "❌";
    console.log(
      `  ${mark} seq ${String(r.sequence).padStart(3)}  hash:${r.checks.contentHashMatches ? "ok" : "BAD"} ` +
        `sig:${r.checks.signatureValid ? "ok" : "BAD"} link:${r.checks.chainLinkValid ? "ok" : "BAD"}`,
    );
  }
  console.log(`\nChain verification: ${report.ok ? "PASS ✅ — admissible" : "FAIL ❌"}`);
  if (!report.ok) {
    console.error("Errors:", report.errors);
    process.exit(1);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
