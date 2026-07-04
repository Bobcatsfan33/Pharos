/**
 * Standalone external verifier.
 *
 * This demonstrates the M0 exit criterion: a third party can validate a record (and
 * the whole chain) using ONLY the exported records and the published public keyset —
 * no Pharos infrastructure, no database, no trust in the platform.
 *
 * In a real audit the verifier receives an evidence bundle (records JSON + keyset
 * JSON) out of band. Use --bundle for that fully-offline path. Without --bundle,
 * this script fetches the bundle from the running API to keep the demo self-contained,
 * then verifies entirely with @pharos/core's pure functions.
 *
 *   Usage:
 *     tsx scripts/external-verify.ts --bundle ./evidence-bundle.json
 *     tsx scripts/external-verify.ts <tenantId> [apiBaseUrl]
 */
import { readFileSync } from "node:fs";
import { verifyChain, type ActionRecord, type PublicKeyEntry } from "../packages/core/src/index.js";

type EvidenceBundle = {
  tenantId?: string;
  records: ActionRecord[];
  keyset?: PublicKeyEntry[];
  keys?: PublicKeyEntry[];
};

const args = process.argv.slice(2);
const bundleIndex = args.indexOf("--bundle");
const bundlePath = bundleIndex >= 0 ? args[bundleIndex + 1] : undefined;
const positional = args.filter((_, index) => index !== bundleIndex && index !== bundleIndex + 1);
const tenantId = positional[0] ?? "demo-tenant";
const base = positional[1] ?? "http://localhost:4000";

// Evidence reads are authenticated and audited; the auditor presents a read-scoped key.
// (The published keyset is public — verification math needs no credentials.)
function auditorKey(): string | undefined {
  return process.env.PHAROS_API_KEY ?? readKeyFile();
}
function readKeyFile(): string | undefined {
  try {
    return readFileSync(".pharos-demo-auditor-key", "utf8").trim();
  } catch {
    return undefined;
  }
}

async function getJson<T>(path: string, authenticated = true): Promise<T> {
  const headers: Record<string, string> = {};
  const key = auditorKey();
  if (authenticated && key) headers["x-api-key"] = key;
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  const body = (await res.json()) as { data: T };
  return body.data;
}

function readBundle(path: string): { tenantId: string; records: ActionRecord[]; keys: PublicKeyEntry[] } {
  const bundle = JSON.parse(readFileSync(path, "utf8")) as EvidenceBundle;
  const keys = bundle.keyset ?? bundle.keys;
  if (!Array.isArray(bundle.records) || bundle.records.length === 0) {
    throw new Error("bundle must contain a non-empty records array");
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("bundle must contain a non-empty keyset or keys array");
  }
  return {
    tenantId: bundle.tenantId ?? bundle.records[0]!.content.tenantId,
    records: bundle.records,
    keys,
  };
}

function printReport(records: ActionRecord[], keys: PublicKeyEntry[]): void {
  console.log(`Verifying ${records.length} records with @pharos/core ONLY (no DB, no signer, no platform calls)...\n`);

  const report = verifyChain(records, keys);

  for (const r of report.records) {
    const mark = r.ok ? "OK " : "BAD";
    console.log(
      `  ${mark} seq ${String(r.sequence).padStart(3)}  hash:${r.checks.contentHashMatches ? "ok" : "BAD"} ` +
        `sig:${r.checks.signatureValid ? "ok" : "BAD"} link:${r.checks.chainLinkValid ? "ok" : "BAD"}`,
    );
  }
  console.log(`\nChain verification: ${report.ok ? "PASS - admissible" : "FAIL"}`);
  if (!report.ok) {
    console.error("Errors:", report.errors);
    process.exit(1);
  }
  console.log("");
}

async function main(): Promise<void> {
  if (bundleIndex >= 0) {
    if (!bundlePath) throw new Error("--bundle requires a path");
    const bundle = readBundle(bundlePath);
    console.log(`\n=== Offline evidence bundle verification for tenant "${bundle.tenantId}" ===`);
    printReport(bundle.records, bundle.keys);
    return;
  }

  console.log(`\n=== External verification of tenant "${tenantId}" (offline, zero-trust) ===`);

  // Fetch the evidence bundle: records + published keyset.
  const { count } = await getJson<{ count: number }>(`/v1/chain/${tenantId}`);
  const records: ActionRecord[] = [];
  for (let seq = 0; seq < count; seq++) {
    records.push(await getJson<ActionRecord>(`/v1/records/${tenantId}/${seq}`));
  }
  const { keys } = await getJson<{ keys: PublicKeyEntry[] }>(`/v1/keyset`, false);

  console.log(`Fetched ${records.length} records and ${keys.length} public keys.`);
  printReport(records, keys);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
