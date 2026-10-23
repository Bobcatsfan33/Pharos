import { parseArgs } from "node:util";
import { requireProject } from "../project.js";
import { openPlatform } from "../platform.js";
import { bold, cyan, decisionBadge, dim, print, shortHash, table } from "../ui.js";

export const logHelp = `pharos log [--tenant <id>] [--limit <n>] [--json]

  The sealed chain, newest last: sequence, verdict, tier, action, cited rule, hash.`;

export async function log(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      tenant: { type: "string" },
      limit: { type: "string", default: "50" },
      json: { type: "boolean", default: false },
    },
  });
  const project = requireProject();
  const tenantId = values.tenant ?? project.config.tenant;
  const platform = await openPlatform(project);
  try {
    const chain = await platform.store.getChain(tenantId);
    const limit = Math.max(1, Number(values.limit) || 50);
    const shown = chain.slice(-limit);
    if (values.json) {
      print(JSON.stringify(shown, null, 2));
      return 0;
    }
    if (chain.length === 0) {
      print(dim(`no records for tenant ${tenantId} — run \`pharos demo\` or govern something`));
      return 0;
    }
    const head = chain[chain.length - 1]!;
    print(
      `${bold(tenantId)}  ${dim(`${chain.length} records · head #${head.content.sequence} ${shortHash(head.seal.contentHash)} · ${platform.storage.posture.backend} storage`)}`,
      "",
      table(
        [
          [
            dim("seq"),
            dim("verdict"),
            dim("tier"),
            dim("action"),
            dim("cited rule"),
            dim("sealed at"),
            dim("hash"),
          ],
          ...shown.map((r) => [
            `#${r.content.sequence}`,
            decisionBadge(r.content.verdict.decision),
            String(r.content.verdict.tierReached),
            r.content.action.type,
            r.content.verdict.ruleCitations[0]?.ruleId
              ? cyan(r.content.verdict.ruleCitations[0].ruleId)
              : dim("—"),
            r.content.sealedAt.replace("T", " ").slice(0, 19),
            shortHash(r.seal.contentHash),
          ]),
        ],
        [6, 8, 4, 28, 32, 19, 13],
      ),
    );
    if (shown.length < chain.length)
      print("", dim(`… ${chain.length - shown.length} earlier records (--limit)`));
    return 0;
  } finally {
    await platform.close();
  }
}
