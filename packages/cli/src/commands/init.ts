import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_DATA_DIR,
  readIfPresent,
  DEFAULT_POLICIES,
  DEFAULT_TENANT,
  PROJECT_FILE,
  ensureGitignored,
  findProject,
  renderProjectFile,
  type ProjectConfig,
} from "../project.js";
import { openPlatform } from "../platform.js";
import { bold, dim, kv, ok, print, warn } from "../ui.js";
import { claudeCodeHookSettings, CLAUDE_CODE_HOOK_MATCHER } from "./hook.js";

export const initHelp = `pharos init [--tenant <id>] [--data-dir <dir>] [--force] [--claude-code]

  Write ${PROJECT_FILE} here, create the embedded data directory, and seal the tenant's
  signing key. Needs nothing installed but Node. Safe to re-run.
  --claude-code   also install the PreToolUse hook into .claude/settings.json so every Bash,
                  Write/Edit, Read and MCP tool call Claude Code makes here is governed and sealed.`;

/** Merge the hook into .claude/settings.json without disturbing anything else in it. */
export function installClaudeCodeHook(root: string): { file: string; changed: boolean } {
  const dir = join(root, ".claude");
  const file = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  const text = readIfPresent(file);
  if (text !== null) {
    try {
      settings = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch (err) {
      throw new Error(`${file} is not valid JSON; fix it or move it aside`, { cause: err });
    }
  }
  const hooks = ((settings.hooks as Record<string, unknown>) ??= {});
  const pre = ((hooks.PreToolUse as unknown[]) ??= []);
  const already = pre.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      JSON.stringify((entry as { hooks?: unknown }).hooks ?? []).includes(
        "@getpharos/cli hook claude-code",
      ),
  );
  if (already) return { file, changed: false };
  pre.push(claudeCodeHookSettings());
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, changed: true };
}

export async function init(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      tenant: { type: "string", default: DEFAULT_TENANT },
      "data-dir": { type: "string", default: DEFAULT_DATA_DIR },
      force: { type: "boolean", default: false },
      "claude-code": { type: "boolean", default: false },
    },
  });
  const root = process.cwd();
  const file = join(root, PROJECT_FILE);
  const existing = findProject(root);
  if (existing && existing.root === root && !values.force) {
    print(warn(`${PROJECT_FILE} already exists here (use --force to rewrite it)`));
  } else {
    const config: ProjectConfig = {
      version: 1,
      tenant: values.tenant!,
      storage: { backend: "embedded", dataDir: values["data-dir"]! },
      policies: [...DEFAULT_POLICIES],
    };
    writeFileSync(file, renderProjectFile(config));
    print(ok(`wrote ${bold(PROJECT_FILE)}`));
  }
  const project = findProject(root)!;
  mkdirSync(project.dataDir, { recursive: true, mode: 0o700 });
  if (ensureGitignored(root, project.config.storage.dataDir)) {
    print(ok(`added ${project.config.storage.dataDir}/ to .gitignore`));
  }

  // Boot once so the keystore, passphrase file, database and evidence directory exist and the
  // tenant's signing key is minted — the first verdict then costs milliseconds, not seconds.
  const platform = await openPlatform(project);
  try {
    const tenant = await platform.tenants.createTenant({
      tenantId: project.config.tenant,
      displayName: project.config.tenant,
    });
    const keyId = await platform.signer.ensureKey(tenant.kmsKeyName);
    const posture = platform.storage.posture;
    print(
      ok(`embedded storage ready in ${bold(resolve(project.dataDir))}`),
      kv("tenant", tenant.tenantId),
      kv("signing", `${keyId} (Ed25519, local keystore)`),
      kv("backend", `${posture.backend} — ${dim("tamper-evident, offline-verifiable; not WORM")}`),
      "",
      `Next: ${bold("pharos demo")} seals three verdicts and verifies the chain.`,
    );
  } finally {
    await platform.close();
  }
  if (values["claude-code"]) {
    const { file, changed } = installClaudeCodeHook(root);
    print(
      changed
        ? ok(`installed the Claude Code hook in ${bold(file)}`)
        : ok(`Claude Code hook already present in ${file}`),
      kv("matcher", CLAUDE_CODE_HOOK_MATCHER),
      kv(
        "decides",
        "block → deny · escalate → ask · allow → Claude Code's own rules; every call sealed to .pharos/",
      ),
      dim("  Start (or restart) Claude Code in this directory; `pharos log` shows what it did."),
    );
  }
  return readIfPresent(join(project.dataDir, "pharos.db")) === null ? 1 : 0;
}
