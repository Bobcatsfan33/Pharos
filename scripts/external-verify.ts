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
 *     tsx scripts/external-verify.ts --bundle ./evidence-bundle.json \
 *       --tsa-cert-sha256 <approved-leaf-certificate-fingerprint>
 *     tsx scripts/external-verify.ts <tenantId> [apiBaseUrl]
 */
import { readFileSync } from "node:fs";
import {
  verifyChain,
  keysetVerifier,
  type ActionRecord,
  type PublicKeyEntry,
} from "../packages/core/src/index.js";
import { verifyTimestamp, type TrustedTimestamp } from "../packages/evidence/src/index.js";

type EvidenceBundle = {
  tenantId?: string;
  records: ActionRecord[];
  keyset?: PublicKeyEntry[];
  keys?: PublicKeyEntry[];
  /** Trusted-time anchors over chain heads (local-signed or RFC 3161 tokens). */
  anchors?: TrustedTimestamp[];
  /** Published TSA public keys (for `local` anchors; rfc3161 tokens self-verify). */
  tsaKeyset?: PublicKeyEntry[];
};

const args = process.argv.slice(2);
const bundleIndex = args.indexOf("--bundle");
const bundlePath = bundleIndex >= 0 ? args[bundleIndex + 1] : undefined;
const pinIndex = args.indexOf("--tsa-cert-sha256");
const pinValue = pinIndex >= 0 ? args[pinIndex + 1] : process.env.PHAROS_TSA_CERT_SHA256;
const tsaCertPins = (pinValue ?? "")
  .split(",")
  .map((value) => value.replaceAll(":", "").trim().toLowerCase())
  .filter(Boolean);
if (tsaCertPins.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
  throw new Error(
    "--tsa-cert-sha256 must contain comma-separated SHA-256 certificate fingerprints",
  );
}
// Only mask flag indexes that are actually PRESENT. `indexOf` returns -1 when a flag is
// absent, and -1 + 1 === 0 — which silently swallowed the first positional argument, so
// `verify:external acme-treasury` verified "demo-tenant" instead.
const optionIndexes = new Set<number>();
if (bundleIndex >= 0) optionIndexes.add(bundleIndex).add(bundleIndex + 1);
if (pinIndex >= 0) optionIndexes.add(pinIndex).add(pinIndex + 1);
const positional = args.filter((_, index) => !optionIndexes.has(index));
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

function readBundle(path: string): {
  tenantId: string;
  records: ActionRecord[];
  keys: PublicKeyEntry[];
  anchors: TrustedTimestamp[];
  tsaKeys: PublicKeyEntry[];
} {
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
    anchors: bundle.anchors ?? [],
    tsaKeys: bundle.tsaKeyset ?? [],
  };
}

/** Verify trusted-time anchors offline: local anchors against the TSA keyset, rfc3161 tokens
 *  against their own embedded cert. Reports and fails on any invalid or unanchored-head case. */
function verifyAnchors(
  anchors: TrustedTimestamp[],
  tsaKeys: PublicKeyEntry[],
  headHash: string,
  trustedCertSha256: string[],
): boolean {
  if (anchors.length === 0) return true; // anchors are optional in a bundle
  if (anchors.some((anchor) => anchor.provider === "rfc3161") && trustedCertSha256.length === 0) {
    throw new Error(
      "RFC 3161 verification requires --tsa-cert-sha256 from an independent approved source",
    );
  }
  const verifyTsa = keysetVerifier(tsaKeys);
  let headAnchored = false;
  let allOk = true;
  for (const a of anchors) {
    const ok = verifyTimestamp(a, verifyTsa, { trustedCertSha256 });
    const kind = a.provider ?? "local";
    console.log(
      `  ${ok ? "OK " : "BAD"} anchor [${kind}] ${a.hash.slice(0, 12)}… @ ${a.time}` +
        (a.hash === headHash ? "  (head)" : ""),
    );
    if (!ok) allOk = false;
    if (ok && a.hash === headHash) headAnchored = true;
  }
  if (!headAnchored) {
    console.error("  BAD no valid anchor covers the head record");
    allOk = false;
  }
  return allOk;
}

function printReport(
  records: ActionRecord[],
  keys: PublicKeyEntry[],
  anchors: TrustedTimestamp[] = [],
  tsaKeys: PublicKeyEntry[] = [],
  trustedCertSha256: string[] = [],
): void {
  console.log(
    `Verifying ${records.length} records with @pharos/core ONLY (no DB, no signer, no platform calls)...\n`,
  );

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

  if (anchors.length > 0) {
    const headHash = records[records.length - 1]!.seal.contentHash;
    console.log(`\nTrusted-time anchors (${anchors.length}):`);
    const anchorsOk = verifyAnchors(anchors, tsaKeys, headHash, trustedCertSha256);
    console.log(
      `\nAnchor verification: ${anchorsOk ? "PASS - head existed before the stamped time" : "FAIL"}`,
    );
    if (!anchorsOk) process.exit(1);
  }
  console.log("");
}

async function main(): Promise<void> {
  if (bundleIndex >= 0) {
    if (!bundlePath) throw new Error("--bundle requires a path");
    const bundle = readBundle(bundlePath);
    console.log(`\n=== Offline evidence bundle verification for tenant "${bundle.tenantId}" ===`);
    printReport(bundle.records, bundle.keys, bundle.anchors, bundle.tsaKeys, tsaCertPins);
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
