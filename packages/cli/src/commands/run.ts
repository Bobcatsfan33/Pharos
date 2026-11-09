import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import type { ActionIntent, LiabilityContext, VerdictContext } from "@pharos/core";
import type { PolicyArtifact } from "@pharos/policy";
import type { Platform } from "@pharos/api";
import { projectPolicies, requireProject } from "../project.js";
import { openPlatform } from "../platform.js";
import { bold, cyan, decisionBadge, dim, print, printError, shortHash, yellow } from "../ui.js";

export const runHelp = `pharos run [--agent <id>] [--tenant <id>] -- <command> [args...]

  Govern a shell command: submit it for a verdict, seal the record, and only then execute.
    allow / modify  -> the command runs; pharos exits with its exit code
    block           -> the command never runs; exit 2, the cited rule is printed
    escalate        -> the command is held, not run; exit 3 (a human resolves it)
  The verdict is sealed before anything executes, whatever the decision.`;

/** Exit codes a wrapper (shell, hook, CI) can act on. */
export const RUN_EXIT = { blocked: 2, escalated: 3 } as const;

/** The action a command line becomes; shared with the Claude Code hook. */
export function actionForCommand(
  argv: string[],
  agentId: string,
  cwd = process.cwd(),
): ActionIntent {
  return {
    type: "shell.exec",
    agentId,
    payload: { command: argv.join(" "), argv, cwd },
    emittedAt: new Date().toISOString(),
  };
}

/** Fail closed: a command we know nothing about is treated as irreversible with a human in the loop. */
export const COMMAND_LIABILITY: LiabilityContext = {
  mandate: null,
  oversightMode: "human_in_loop",
  blastRadius: { financialAmount: 0, currency: "USD", reversibility: "irreversible" },
  modelMetadata: null,
};

export async function govern(
  platform: Platform,
  tenantId: string,
  action: ActionIntent,
  policies: PolicyArtifact[],
): Promise<{ verdict: VerdictContext; sequence: number; hash: string }> {
  const verdict = await platform.cascade.evaluate(
    { tenantId, action, liability: COMMAND_LIABILITY },
    new Date(),
    policies,
  );
  // Sealed BEFORE the command runs: there is no path on which an action executes unrecorded.
  const record = await platform.store.append({
    tenantId,
    action,
    verdict,
    liability: COMMAND_LIABILITY,
  });
  return { verdict, sequence: record.content.sequence, hash: record.seal.contentHash };
}

export async function run(argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  const { values } = parseArgs({
    args: own,
    options: { agent: { type: "string", default: "pharos-run" }, tenant: { type: "string" } },
  });
  if (command.length === 0) {
    printError("nothing to run — usage: pharos run -- <command> [args...]");
    return 2;
  }
  const project = requireProject();
  const tenantId = values.tenant ?? project.config.tenant;
  const platform = await openPlatform(project);
  let outcome: Awaited<ReturnType<typeof govern>>;
  try {
    await platform.tenants.createTenant({ tenantId, displayName: tenantId });
    outcome = await govern(
      platform,
      tenantId,
      actionForCommand(command, values.agent!),
      projectPolicies(project),
    );
  } finally {
    await platform.close();
  }
  const { verdict, sequence, hash } = outcome;
  const cited = verdict.ruleCitations[0];
  const where = `${dim("sealed")} #${sequence} ${shortHash(hash)}`;
  if (verdict.decision === "block") {
    print(
      `${decisionBadge("block")} ${bold(command.join(" "))}`,
      cited
        ? `  ${dim("cited")} ${cyan(cited.ruleId)}${cited.clause ? dim(` · ${cited.clause}`) : ""}`
        : "",
      cited?.description ? `  ${cited.description}` : "",
      `  ${where}`,
    );
    return RUN_EXIT.blocked;
  }
  if (verdict.decision === "escalate") {
    print(
      `${decisionBadge("escalate")} ${bold(command.join(" "))}`,
      cited
        ? `  ${dim("cited")} ${cyan(cited.ruleId)}${cited.clause ? dim(` · ${cited.clause}`) : ""}`
        : "",
      cited?.description ? `  ${cited.description}` : "",
      `  ${yellow("held")} — not executed; a human must confirm this one. ${where}`,
    );
    return RUN_EXIT.escalated;
  }
  print(`${decisionBadge(verdict.decision)} ${dim(command.join(" "))}  ${where}`);
  return new Promise<number>((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", shell: false });
    child.on("error", (err) => {
      printError(`failed to start ${command[0]}: ${err.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
