/**
 * M0 exit-criteria demo (durability + chain integrity).
 *
 * Run TWICE against the same infrastructure to prove restart durability:
 *
 *   1. pnpm infra:up
 *   2. pnpm demo:durability            # submits actions, prints the head
 *   3. (kill nothing — the platform process exits; Postgres/WORM persist)
 *   4. pnpm demo:durability --verify    # reopens cold, finds records, verifies chain
 *
 * The first run submits a demo agent's actions and seals their records. The second
 * run (or the --verify flag) reconnects to the durable stores with a fresh process —
 * simulating a platform restart — and verifies the full chain from genesis to head.
 */
import { writeFileSync } from "node:fs";
import { buildPlatform } from "../services/api/src/platform.js";

const DEMO_TENANT = "demo-tenant";
const AUDITOR_KEY_FILE = ".pharos-demo-auditor-key";

const DEMO_ACTIONS = [
  {
    action: { type: "email.send", agentId: "agent-001", payload: { to: "client@example.com" } },
    liability: {
      mandate: { id: "m-comms", scope: "client communications", limits: {}, grantor: "compliance", expiresAt: null, version: "1" },
      oversightMode: "human_on_loop" as const,
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" as const },
      modelMetadata: { provider: "anthropic", model: "claude-opus-4-8" },
    },
  },
  {
    action: { type: "payment.transfer", agentId: "agent-001", payload: { amount: 30000, to: "vendor-x" } },
    liability: {
      mandate: { id: "m-funds", scope: "vendor payments", limits: { maxAmount: 25000 }, grantor: "treasury", expiresAt: null, version: "1" },
      oversightMode: "human_in_loop" as const,
      blastRadius: { financialAmount: 30000, currency: "USD", reversibility: "irreversible" as const },
      modelMetadata: { provider: "anthropic", model: "claude-opus-4-8" },
    },
  },
  {
    action: { type: "crm.update", agentId: "agent-002", payload: { record: "lead-42" } },
    liability: {
      mandate: null,
      oversightMode: "autonomous" as const,
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" as const },
      modelMetadata: null,
    },
  },
];

async function submit(): Promise<void> {
  const platform = await buildPlatform();
  try {
    // Provision the tenant (per-tenant signing key) and mint a read-scoped auditor key
    // so the external verifier can fetch the evidence bundle.
    const tenant = await platform.tenants.createTenant({ tenantId: DEMO_TENANT, displayName: "Demo Tenant" });
    await platform.signer.ensureKey(tenant.kmsKeyName);
    const auditor = await platform.apiKeys.create(DEMO_TENANT, "demo-auditor", ["records:read", "chain:verify"]);
    writeFileSync(AUDITOR_KEY_FILE, auditor.plaintext);
    console.log(`Provisioned tenant + auditor key (saved to ${AUDITOR_KEY_FILE}).`);

    console.log(`\n=== Submitting ${DEMO_ACTIONS.length} demo actions for tenant "${DEMO_TENANT}" ===`);
    for (const item of DEMO_ACTIONS) {
      const action = { ...item.action, payload: item.action.payload ?? {}, emittedAt: new Date().toISOString() };
      const verdict = platform.engine.evaluate({ tenantId: DEMO_TENANT, action, liability: item.liability }, new Date());
      const record = await platform.store.append({ tenantId: DEMO_TENANT, action, verdict, liability: item.liability });
      console.log(
        `  seq ${record.content.sequence}  ${action.type.padEnd(18)}  -> ${verdict.decision.toUpperCase().padEnd(9)}` +
          `  hash ${record.seal.contentHash.slice(0, 12)}…`,
      );
    }
    const head = await platform.store.getHead(DEMO_TENANT);
    console.log(`\nChain head: sequence ${head?.sequence} hash ${head?.hash.slice(0, 16)}…`);
    console.log("Records are now durable in Postgres + WORM. Re-run with --verify to simulate a cold restart.\n");
  } finally {
    await platform.close();
  }
}

async function verify(): Promise<void> {
  // Fresh process, fresh connections: this is the "platform killed and restarted" case.
  const platform = await buildPlatform();
  try {
    console.log(`\n=== Cold verification for tenant "${DEMO_TENANT}" (simulated restart) ===`);
    const count = await platform.store.count(DEMO_TENANT);
    console.log(`Found ${count} persisted records after restart.`);
    if (count === 0) {
      console.error("No records found — run the demo without --verify first.");
      process.exitCode = 1;
      return;
    }
    const report = await platform.integrity.verifyTenant(DEMO_TENANT);
    console.log(`Genesis-to-head chain verification: ${report.ok ? "PASS ✅" : "FAIL ❌"}`);
    console.log(`  records checked: ${report.recordsChecked}`);
    if (!report.ok) {
      console.error("  errors:", report.errors);
      process.exitCode = 1;
    }
    console.log("");
  } finally {
    await platform.close();
  }
}

const isVerify = process.argv.includes("--verify");
(isVerify ? verify() : submit()).catch((err) => {
  console.error(err);
  process.exit(1);
});
