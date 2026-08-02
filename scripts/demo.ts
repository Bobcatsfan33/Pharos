/**
 * The Pharos demo: one story, start to finish.
 *
 * An agent tries to move money it has no authority to move, and Pharos stops it — citing
 * the specific FINRA clause. A treasury controller grants a mandate. The same transfer
 * now passes. Both decisions are sealed into an evidence chain that a third party can
 * verify offline, with no Pharos infrastructure and no trust in us.
 *
 * Hermetic and free: local KMS signing and the local timestamp authority, so this runs
 * with nothing but `pnpm infra:up`. Production swaps in AWS KMS and a real RFC 3161
 * authority through the same interfaces — see docs/LIMITATIONS.md.
 */
import { writeFileSync } from "node:fs";
import { buildPlatform } from "../services/api/src/platform.js";
import type { LiabilityContext, VerdictContext } from "@pharos/core";

const TENANT = "acme-treasury";
const AGENT = "treasury-bot";
const AUDITOR_KEY_FILE = ".pharos-demo-auditor-key";
const BUNDLE_FILE = "evidence-bundle.json";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;

function decisionColor(d: string): string {
  if (d === "allow") return green(d.toUpperCase());
  if (d === "block") return red(d.toUpperCase());
  return amber(d.toUpperCase());
}

function act(n: number, title: string): void {
  console.log(`\n${bold(`── Act ${n} ─ ${title}`)}\n`);
}

/** The transfer the agent wants to make. Identical in both acts; only authority differs. */
const TRANSFER = {
  type: "payment.transfer",
  agentId: AGENT,
  payload: {
    to: "new-vendor-8812",
    amount: 4_800,
    currency: "USD",
    memo: "please wire the funds to this account for invoice 8812",
  },
};

function liability(mandate: LiabilityContext["mandate"]): LiabilityContext {
  return {
    mandate,
    oversightMode: "autonomous",
    blastRadius: { financialAmount: 4_800, currency: "USD", reversibility: "reversible" },
    modelMetadata: { provider: "anthropic", model: "claude-opus-4-8" },
  } as LiabilityContext;
}

function showVerdict(verdict: VerdictContext): void {
  console.log(
    `  Verdict:   ${decisionColor(verdict.decision)}   ${dim(`tier ${verdict.tierReached}`)}`,
  );
  for (const c of verdict.ruleCitations) {
    console.log(`  Cited:     ${bold(c.ruleId)}  ${dim(c.clause ?? "")}`);
    if (c.description) console.log(`             ${dim(c.description)}`);
  }
}

async function main(): Promise<void> {
  const platform = await buildPlatform();
  try {
    console.log(bold("\n═══ Pharos demo — an agent tries to move money ═══"));
    console.log(dim("Signing: local KMS.  Trusted time: local TSA.  Nothing leaves this machine."));

    await platform.tenants
      .createTenant({ tenantId: TENANT, displayName: "Acme Treasury" })
      .catch(() => {});

    // Evidence reads are authenticated and audited, so leave the auditor a read-scoped
    // key. Verification MATH needs no credentials — the keyset is public — but fetching
    // the records does.
    const auditor = await platform.apiKeys.create(TENANT, "demo-auditor", [
      "records:read",
      "chain:verify",
    ]);
    writeFileSync(AUDITOR_KEY_FILE, auditor.plaintext);

    // ---------------------------------------------------------------- Act 1
    act(1, "the agent acts without authority");
    console.log(`  ${AGENT} wants to wire ${bold("$4,800")} to ${bold("new-vendor-8812")}.`);
    console.log(`  It holds ${bold("no mandate")} for moving funds.\n`);

    const unmandated = await platform.store.append({
      tenantId: TENANT,
      action: { ...TRANSFER, emittedAt: new Date().toISOString() },
      verdict: await platform.cascade.evaluate(
        {
          tenantId: TENANT,
          action: { ...TRANSFER, emittedAt: new Date().toISOString() },
          liability: liability(null),
        },
        new Date(),
        await platform.activePolicyArtifacts(TENANT),
      ),
      liability: liability(null),
    });
    showVerdict(unmandated.content.verdict);
    console.log(`\n  ${dim("Sealed as evidence anyway — a refusal is a fact worth proving.")}`);
    console.log(
      `  ${dim(`record #${unmandated.content.sequence}  hash ${unmandated.seal.contentHash.slice(0, 16)}…`)}`,
    );

    // ---------------------------------------------------------------- Act 2
    act(2, "treasury grants a mandate");
    const mandateId = "m-vendor-payments";
    await platform.mandates.create({
      tenantId: TENANT,
      mandateId,
      scope: "vendor payments up to $25,000",
      limits: { maxAmount: 25_000, currency: "USD" },
      grantor: "treasury-controller",
      expiresAt: null,
    });
    console.log(
      `  ${bold("treasury-controller")} grants ${bold(mandateId)} — vendor payments up to $25,000.`,
    );
    console.log(
      `  ${dim("The mandate is stored server-side. A caller cannot assert one it was not granted.")}\n`,
    );

    const mandate = await platform.mandates.getActive(TENANT, mandateId);
    const mandatedLiability = liability(mandate);
    const mandated = await platform.store.append({
      tenantId: TENANT,
      action: { ...TRANSFER, emittedAt: new Date().toISOString() },
      verdict: await platform.cascade.evaluate(
        {
          tenantId: TENANT,
          action: { ...TRANSFER, emittedAt: new Date().toISOString() },
          liability: mandatedLiability,
        },
        new Date(),
        await platform.activePolicyArtifacts(TENANT),
      ),
      liability: mandatedLiability,
    });
    console.log(`  Same transfer. Same agent. Same amount.\n`);
    showVerdict(mandated.content.verdict);
    console.log(
      `\n  ${dim(`record #${mandated.content.sequence}  hash ${mandated.seal.contentHash.slice(0, 16)}…`)}`,
    );

    // ---------------------------------------------------------------- Act 3
    act(3, "the evidence anchors in trusted time");
    const anchor = await platform.anchorHead(TENANT);
    if (anchor) {
      console.log(`  Chain head sequence ${bold(String(anchor.sequence))} anchored.`);
      console.log(`  ${dim("The anchor proves the head existed before the stamped time —")}`);
      console.log(`  ${dim("signed by an independent authority, not by Pharos's own keys.")}`);
    } else {
      console.log(`  ${amber("No anchor produced")} ${dim("(is PHAROS_TSA_PROVIDER set?)")}`);
    }

    // ---------------------------------------------------------------- Act 4
    act(4, "the bundle a third party can check without us");
    const head = await platform.store.getHead(TENANT);
    const stamp = head ? await platform.tsa.timestamp(head.hash) : null;
    const bundle = {
      tenantId: TENANT,
      records: await platform.store.getChain(TENANT),
      keyset: await platform.signer.publishKeyset(),
      tsaKeyset: await platform.tsaKeyset(),
      anchors: stamp ? [stamp] : [],
    };
    writeFileSync(BUNDLE_FILE, JSON.stringify(bundle, null, 2));
    console.log(`  Wrote ${bold(BUNDLE_FILE)} — ${bundle.records.length} records, the public`);
    console.log(`  keyset, and the trusted-time anchor. No secrets: only public keys.\n`);
    console.log(`  ${dim("This file is the whole evidence package. Hand it to an auditor,")}`);
    console.log(`  ${dim("a regulator, or opposing counsel — they need nothing else.")}`);

    console.log(`\n${bold("═══ Two decisions, both provable ═══")}`);
    console.log(`  Verify the bundle yourself, offline, trusting nothing:\n`);
    console.log(`      ${bold(`pnpm verify:bundle ${BUNDLE_FILE}`)}\n`);
  } finally {
    await platform.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
