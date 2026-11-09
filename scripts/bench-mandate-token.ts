/**
 * Workstream A exit gate: Tier-1-only verdicts carrying a MandateToken.
 *
 *   pnpm bench:mandate-token [verdicts]
 *
 * Each iteration does what the server does on the request path for a token: verify the chain
 * (one root signature + one Ed25519 signature per block + the proof), fold the effective
 * authority into the liability, and run Tier 1. No Tier 2/3, no sealing — this number says
 * nothing about the judges. Gate: ≥ 1,000 verdicts/s single process. Writes PHAROS_BENCH_OUTPUT.
 */
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import {
  VerdictEngine,
  attenuateMandateToken,
  mintMandateToken,
  type PublicKeyEntry,
  type SigningProvider,
  type VerdictRequest,
} from "../packages/core/src/index.js";

const VERDICTS = Number(process.argv[2] ?? 20_000);
const GATE_PER_SEC = 1000;
const OUTPUT = process.env.PHAROS_BENCH_OUTPUT;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function localRoot(): { signer: SigningProvider; entry: PublicKeyEntry } {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.alloc(32, 9)]),
    format: "der",
    type: "pkcs8",
  });
  const keyId = "mandate:bench#v1";
  const entry: PublicKeyEntry = {
    keyId,
    publicKey: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"),
    algorithm: "ed25519",
  };
  const signer: SigningProvider = {
    providerId: "bench",
    ensureKey: async () => keyId,
    rotate: async () => keyId,
    activeKeyId: async () => keyId,
    sign: async (_k, m) => nodeSign(null, m, key).toString("base64"),
    verify: async () => true,
    getPublicKey: async () => entry,
    publishKeyset: async () => [entry],
  };
  return { signer, entry };
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function main(): Promise<void> {
  const { signer, entry } = localRoot();
  const now = new Date("2026-10-30T12:00:00.000Z");
  const root = await mintMandateToken(
    {
      tenantId: "bench",
      agentId: "agent",
      mandateId: "vendor-payments",
      grantor: "cfo",
      issuedAt: now.toISOString(),
      expiresAt: "2036-01-01T00:00:00.000Z",
      scope: { actionTypes: ["payment.", "invoice.read"], resources: ["acct:*"] },
      limits: { financialAmount: 25000, currency: "USD" },
      citations: ["treasury-policy-7"],
    },
    signer,
    entry.keyId,
  );
  const t1 = attenuateMandateToken(root, {
    checks: [{ kind: "limit", value: { financialAmount: 5000 } }],
    issuedAt: now.toISOString(),
  });
  const token = attenuateMandateToken(t1, {
    checks: [{ kind: "scope", value: { actionTypes: ["payment.transfer"] } }],
    issuedAt: now.toISOString(),
  });
  const engine = new VerdictEngine({ deadlineMs: 800 });
  const req = (amount: number): VerdictRequest => ({
    tenantId: "bench",
    action: {
      type: "payment.transfer",
      agentId: "agent",
      payload: { amount },
      emittedAt: now.toISOString(),
    },
    liability: {
      mandate: null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: amount, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
    },
    mandateToken: { token, rootKey: entry },
  });

  // Warm-up, then the timed run alternating allow (in limit) and block (over the ceiling).
  for (let i = 0; i < 500; i++) engine.evaluate(req(100), now);
  const latencies: number[] = [];
  let allows = 0;
  let blocks = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < VERDICTS; i++) {
    const s = process.hrtime.bigint();
    const v = engine.evaluate(req(i % 2 === 0 ? 100 : 9000), now);
    latencies.push(Number(process.hrtime.bigint() - s) / 1e6);
    if (v.decision === "allow") allows++;
    else if (v.decision === "block") blocks++;
  }
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const perSec = VERDICTS / (wallMs / 1000);
  const sorted = [...latencies].sort((a, b) => a - b);
  if (allows !== VERDICTS / 2 || blocks !== VERDICTS / 2)
    throw new Error(`unexpected verdict mix: allow=${allows} block=${blocks}`);
  const out = {
    schemaVersion: "1.0.0",
    workstream: "A",
    what: "Tier-1-only verdicts with a 3-block MandateToken (verify + fold + Tier 1), single process",
    host: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
    },
    verdicts: VERDICTS,
    blocksPerToken: token.blocks.length,
    signaturesVerifiedPerVerdict: token.blocks.length + 2,
    wallMs,
    verdictsPerSec: perSec,
    latencyMs: {
      p50: pct(sorted, 50),
      p95: pct(sorted, 95),
      p99: pct(sorted, 99),
      max: sorted[sorted.length - 1],
    },
    mix: { allow: allows, block: blocks },
    gate: { verdictsPerSecAtLeast: GATE_PER_SEC, pass: perSec >= GATE_PER_SEC },
  };
  console.log(
    `\n=== Workstream A — Tier-1 mandate-token path (${VERDICTS} verdicts, ${token.blocks.length}-block token) ===`,
  );
  console.log(
    `   throughput ${perSec.toFixed(0)} verdicts/s   gate ≥ ${GATE_PER_SEC}/s: ${out.gate.pass ? "PASS" : "FAIL"}`,
  );
  console.log(
    `   latency p50/p95/p99/max: ${out.latencyMs.p50.toFixed(3)} / ${out.latencyMs.p95.toFixed(3)} / ${out.latencyMs.p99.toFixed(3)} / ${out.latencyMs.max!.toFixed(3)} ms`,
  );
  console.log(
    `   signatures verified per verdict: ${out.signaturesVerifiedPerVerdict}   mix allow/block: ${allows}/${blocks}`,
  );
  if (OUTPUT) writeFileSync(OUTPUT, `${JSON.stringify(out, null, 2)}\n`);
  if (!out.gate.pass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
