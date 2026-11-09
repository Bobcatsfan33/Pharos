import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyEvidenceBundle, type BundleVerification } from "@pharos/evidence";
import { findProject } from "../project.js";
import { openPlatform } from "../platform.js";
import { bold, dim, fail, ok, print, shortHash } from "../ui.js";

export const verifyHelp = `pharos verify [bundle.json] [--tsa-cert-sha256 <hex,...>] [--json]

  Verify every hash, signature, chain link and trusted-time anchor. With a bundle file this
  runs fully offline and needs no project; without one it verifies the local chain.
  Exit code 0 = PASS, 1 = FAIL.`;

export async function verify(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "tsa-cert-sha256": { type: "string" },
      tenant: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const pins = (values["tsa-cert-sha256"] ?? process.env.PHAROS_TSA_CERT_SHA256 ?? "")
    .split(",")
    .map((v) => v.replaceAll(":", "").trim().toLowerCase())
    .filter(Boolean);
  if (pins.some((p) => !/^[a-f0-9]{64}$/.test(p))) {
    throw new Error("--tsa-cert-sha256 must be comma-separated SHA-256 certificate fingerprints");
  }

  let source: string;
  let report: BundleVerification;
  if (positionals[0]) {
    source = positionals[0];
    report = verifyEvidenceBundle(JSON.parse(readFileSync(source, "utf8")), {
      trustedCertSha256: pins,
    });
  } else {
    const project = findProject();
    if (!project)
      throw new Error("give a bundle file to verify, or run inside a project (`pharos init`)");
    const tenantId = values.tenant ?? project.config.tenant;
    const platform = await openPlatform(project);
    try {
      const records = await platform.store.getChain(tenantId);
      if (records.length === 0) throw new Error(`no records for tenant ${tenantId}`);
      const anchors = (await platform.evidenceOps.listAnchors(tenantId)).map((a) => ({
        hash: a.headHash,
        time: a.tsaTime,
        provider: a.provider,
        ...(a.tsaKeyId ? { keyId: a.tsaKeyId } : {}),
        ...(a.tsaSignature ? { signature: a.tsaSignature } : {}),
        ...(a.tsaToken ? { token: a.tsaToken } : {}),
      }));
      source = `local chain (${platform.storage.posture.backend} storage, tenant ${tenantId})`;
      report = verifyEvidenceBundle(
        {
          tenantId,
          records,
          keyset: await platform.signer.publishKeyset(),
          tsaKeyset: await platform.tsaKeyset(),
          anchors,
        },
        { trustedCertSha256: pins },
      );
    } finally {
      await platform.close();
    }
  }

  if (values.json) {
    print(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  print(`${bold("Verifying")} ${source} ${dim("— public keys only, no Pharos required")}`, "");
  for (const r of report.chain.records) {
    const line = `seq ${String(r.sequence).padStart(3)}  hash ${r.checks.contentHashMatches ? "ok " : "BAD"}  sig ${r.checks.signatureValid ? "ok " : "BAD"}  link ${r.checks.chainLinkValid ? "ok " : "BAD"}`;
    print(`  ${r.ok ? ok(line) : fail(line)}`);
  }
  print(
    "",
    report.chain.ok
      ? ok(`chain: PASS — ${report.chain.recordsChecked} records, admissible`)
      : fail(`chain: FAIL — ${report.chain.errors.join("; ")}`),
  );
  if (report.anchors.length > 0) {
    for (const a of report.anchors) {
      const line = `anchor [${a.kind}] ${shortHash(a.anchor.hash)} @ ${a.anchor.time}${a.coversHead ? "  (head)" : ""}`;
      print(`  ${a.ok ? ok(line) : fail(line)}`);
    }
    print(
      report.anchorsOk
        ? ok("anchors: PASS — the head existed before the stamped time")
        : fail("anchors: FAIL"),
    );
  }
  print("");
  return report.ok ? 0 : 1;
}
