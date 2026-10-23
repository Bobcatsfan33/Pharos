import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyEvidenceBundle, type EvidenceBundle } from "@pharos/evidence";
import { requireProject } from "../project.js";
import { openPlatform } from "../platform.js";
import { bold, dim, fail, ok, print } from "../ui.js";

export const exportHelp = `pharos export [--out <bundle.json>] [--tenant <id>] [--anchor]

  Write the evidence bundle — every sealed record, the public keyset, the TSA keyset and all
  trusted-time anchors. Public keys only, never secrets. \`--anchor\` stamps the head first.`;

export async function exportBundle(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string", default: "evidence-bundle.json" },
      tenant: { type: "string" },
      anchor: { type: "boolean", default: false },
    },
  });
  const project = requireProject();
  const tenantId = values.tenant ?? project.config.tenant;
  const platform = await openPlatform(project);
  try {
    if (values.anchor) await platform.anchorHead(tenantId);
    const records = await platform.store.getChain(tenantId);
    if (records.length === 0) throw new Error(`no records for tenant ${tenantId}`);
    const bundle: EvidenceBundle = {
      tenantId,
      records,
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
    const check = verifyEvidenceBundle(bundle);
    writeFileSync(values.out!, JSON.stringify(bundle, null, 2));
    print(
      check.ok
        ? ok(`wrote ${bold(values.out!)}`)
        : fail(`wrote ${values.out!} but it does NOT verify: ${check.errors.join("; ")}`),
      dim(
        `  ${records.length} records · ${bundle.keyset!.length} public keys · ${bundle.anchors!.length} anchors · tenant ${tenantId}`,
      ),
      dim(`  verify anywhere: pharos verify ${values.out}`),
    );
    return check.ok ? 0 : 1;
  } finally {
    await platform.close();
  }
}
