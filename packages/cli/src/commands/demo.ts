import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ActionIntent, LiabilityContext } from "@pharos/core";
import { verifyEvidenceBundle, type EvidenceBundle } from "@pharos/evidence";
import { FINRA_PACK_V2, type PolicyArtifact } from "@pharos/policy";
import type { Platform } from "@pharos/api";
import { projectPolicies, requireProject } from "../project.js";
import { openPlatform } from "../platform.js";
import { bold, cyan, decisionBadge, dim, fail, heading, kv, ok, print, shortHash } from "../ui.js";

export const demoHelp = `pharos demo [--out <bundle.json>] [--no-bundle]

  Three governed actions — one allowed, one blocked by a mandate limit, one escalated by a
  regulation pack — each sealed into the local chain, then the chain verified genesis→head
  and exported as an evidence bundle anyone can check offline with \`pharos verify\`.`;

const AGENT = "treasury-bot";

interface Act {
  title: string;
  story: string;
  action: Omit<ActionIntent, "emittedAt">;
  liability: Omit<LiabilityContext, "mandate">;
  mandateId?: string;
}

const ACTS: Act[] = [
  {
    title: "a routine, reversible action",
    story: `${AGENT} emails a vendor a shipping update.`,
    action: {
      type: "email.send",
      agentId: AGENT,
      payload: { to: "ops@vendor.example", subject: "Shipping update" },
    },
    liability: {
      oversightMode: "human_on_loop",
      blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
    },
    mandateId: "m-comms",
  },
  {
    title: "a transfer over its mandate",
    story: `${AGENT} tries to wire $30,000. Its mandate allows $25,000.`,
    action: {
      type: "payment.transfer",
      agentId: AGENT,
      payload: { amount: 30_000, to: "acct-7781", memo: "vendor invoice" },
    },
    liability: {
      oversightMode: "human_in_loop",
      blastRadius: { financialAmount: 30_000, currency: "USD", reversibility: "irreversible" },
      modelMetadata: null,
    },
    mandateId: "m-funds",
  },
  {
    title: "a transfer with no mandate at all",
    story: `${AGENT} tries to wire $4,800 to a new payee with no authority to move funds.`,
    action: {
      type: "payment.transfer",
      agentId: AGENT,
      payload: {
        amount: 4_800,
        to: "new-vendor-8812",
        memo: "please wire the funds to the new vendor today",
      },
    },
    liability: {
      oversightMode: "autonomous",
      blastRadius: { financialAmount: 4_800, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
    },
  },
];

export async function demo(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string", default: "evidence-bundle.json" },
      bundle: { type: "boolean", default: true },
    },
    allowNegative: true,
  });
  const project = requireProject();
  const platform = await openPlatform(project);
  try {
    // The story is about payments, so the FINRA pack joins whatever the project selected.
    const packs = projectPolicies(project);
    if (!packs.some((p) => p.packId === FINRA_PACK_V2.packId)) packs.push(FINRA_PACK_V2);
    return await run(platform, project.config.tenant, values.bundle ? values.out! : null, packs);
  } finally {
    await platform.close();
  }
}

async function run(
  platform: Platform,
  tenantId: string,
  bundlePath: string | null,
  policies: PolicyArtifact[],
): Promise<number> {
  const started = Date.now();
  await platform.tenants.createTenant({ tenantId, displayName: tenantId });
  await platform.mandates.create({
    tenantId,
    mandateId: "m-comms",
    scope: "vendor communications",
    grantor: "ops-lead",
  });
  await platform.mandates.create({
    tenantId,
    mandateId: "m-funds",
    scope: "vendor payments up to $25,000",
    limits: { maxAmount: 25_000, currency: "USD" },
    grantor: "treasury-controller",
  });
  print(
    `${bold("Pharos demo")} — ${dim(`tenant ${tenantId} · packs ${policies.map((p) => p.packId).join(", ")} · embedded storage · local Ed25519 signing · nothing leaves this machine`)}`,
  );

  for (const [i, act] of ACTS.entries()) {
    print(heading(`Act ${i + 1} · ${act.title}`), `  ${act.story}`);
    const mandate = act.mandateId
      ? await platform.mandates.getActive(tenantId, act.mandateId)
      : null;
    const liability: LiabilityContext = { ...act.liability, mandate };
    const action: ActionIntent = { ...act.action, emittedAt: new Date().toISOString() };
    const verdict = await platform.cascade.evaluate(
      { tenantId, action, liability },
      new Date(),
      policies,
    );
    const record = await platform.store.append({ tenantId, action, verdict, liability });
    const cited = verdict.ruleCitations[0];
    print(
      "",
      `  ${decisionBadge(verdict.decision)} ${dim(`tier ${verdict.tierReached}`)}  ${action.type}` +
        (cited ? `  ${dim("cited")} ${cyan(cited.ruleId)}` : ""),
      ...(cited?.description ? [`  ${dim(cited.description)}`] : []),
      `  ${dim("sealed")} #${record.content.sequence}  ${shortHash(record.seal.contentHash)}  ${dim("prev")} ${shortHash(record.seal.prevHash)}`,
    );
  }

  print(heading("Verify · genesis → head, offline"));
  const anchor = await platform.anchorHead(tenantId);
  const report = await platform.integrity.verifyTenant(tenantId);
  for (const r of report.records) {
    print(
      `  ${r.ok ? ok("") : fail("")}seq ${String(r.sequence).padStart(2)}  hash ${r.checks.contentHashMatches ? "ok " : "BAD"}  sig ${r.checks.signatureValid ? "ok " : "BAD"}  link ${r.checks.chainLinkValid ? "ok " : "BAD"}`,
    );
  }
  print(
    "",
    report.ok
      ? ok(`chain verified: ${report.recordsChecked} records, every hash, signature and link`)
      : fail(`chain FAILED: ${report.errors.join("; ")}`),
    anchor
      ? ok(`head #${anchor.sequence} anchored in trusted time (local TSA, independent keys)`)
      : "",
  );

  if (bundlePath) {
    const bundle: EvidenceBundle = {
      tenantId,
      records: await platform.store.getChain(tenantId),
      keyset: await platform.signer.publishKeyset(),
      tsaKeyset: await platform.tsaKeyset(),
      anchors: (await platform.evidenceOps.listAnchors(tenantId)).map((a) => ({
        hash: a.headHash,
        time: a.tsaTime,
        provider: a.provider,
        ...(a.tsaKeyId ? { keyId: a.tsaKeyId } : {}),
        ...(a.tsaSignature ? { signature: a.tsaSignature } : {}),
        ...(a.tsaToken ? { token: a.tsaToken } : {}),
      })),
    };
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
    const offline = verifyEvidenceBundle(bundle);
    print(
      offline.ok
        ? ok(
            `wrote ${bold(bundlePath)} — ${bundle.records.length} records + public keys only; re-verified offline`,
          )
        : fail(`bundle failed offline verification: ${offline.errors.join("; ")}`),
    );
  }

  print(
    "",
    kv("elapsed", `${Date.now() - started} ms`),
    "",
    `Next: ${bold("pharos log")} to read the chain · ${bold(`pharos verify ${bundlePath ?? "evidence-bundle.json"}`)} to check it anywhere · ` +
      `change one character in the bundle and watch it fail.`,
    dim(
      "Embedded storage is tamper-evident and offline-verifiable, not WORM. Retention needs the Postgres + S3 Object Lock backend.",
    ),
  );
  return report.ok ? 0 : 1;
}
