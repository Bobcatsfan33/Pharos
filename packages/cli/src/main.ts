import { bold, dim, print, printError } from "./ui.js";
import { init, initHelp } from "./commands/init.js";
import { demo, demoHelp } from "./commands/demo.js";
import { log, logHelp } from "./commands/log.js";
import { verify, verifyHelp } from "./commands/verify.js";
import { exportBundle, exportHelp } from "./commands/export.js";

const VERSION = process.env.PHAROS_CLI_VERSION ?? "dev";

type Command = { run: (argv: string[]) => Promise<number>; help: string; summary: string };

const COMMANDS: Record<string, Command> = {
  init: { run: init, help: initHelp, summary: "write pharos.yaml and start embedded storage here" },
  demo: {
    run: demo,
    help: demoHelp,
    summary: "three verdicts, a verified chain, an evidence bundle",
  },
  log: { run: log, help: logHelp, summary: "read the sealed chain" },
  verify: {
    run: verify,
    help: verifyHelp,
    summary: "verify a bundle (or the local chain) offline; exit 0/1",
  },
  export: { run: exportBundle, help: exportHelp, summary: "write the evidence bundle" },
};

function usage(): string {
  const names = Object.keys(COMMANDS);
  const width = Math.max(...names.map((n) => n.length));
  return [
    `${bold("pharos")} ${dim(`v${VERSION}`)} — real-time policy verdicts for AI agents, with a sealed, hash-chained record of every decision.`,
    "",
    `  ${bold("usage:")} pharos <command> [options]`,
    "",
    ...names.map((n) => `  ${n.padEnd(width + 2)} ${COMMANDS[n]!.summary}`),
    "",
    `  pharos <command> --help    options for one command`,
    `  pharos --version`,
    "",
    dim(
      "  Embedded storage: tamper-evident and offline-verifiable, not WORM. Docs: https://github.com/Bobcatsfan33/Pharos",
    ),
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    print(usage());
    return name ? 0 : 1;
  }
  if (name === "--version" || name === "-v") {
    print(VERSION);
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    printError(`unknown command "${name}"`);
    print("", usage());
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    print(command.help);
    return 0;
  }
  try {
    return await command.run(rest);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    printError(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
