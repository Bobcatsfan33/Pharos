import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SHIPPED_PACKS, type PolicyArtifact } from "@pharos/policy";

export const PROJECT_FILE = "pharos.yaml";
export const DEFAULT_DATA_DIR = ".pharos";
export const DEFAULT_TENANT = "local";
/**
 * The wedge pack only. `finra` and `hipaa` are opt-in: their Tier-3 judges are bag-of-words
 * models tuned for communications and payments and over-flag ordinary shell commands.
 */
export const DEFAULT_POLICIES = ["coding-agent-safety"];

/** What `pharos.yaml` holds today. Phase C adds YAML policy packs under `policies:`. */
export interface ProjectConfig {
  version: 1;
  tenant: string;
  storage: { backend: "embedded"; dataDir: string };
  /** Shipped regulation packs to load alongside the Tier-1 rules (code packs: finra, hipaa). */
  policies: string[];
}

export interface Project {
  root: string;
  file: string;
  config: ProjectConfig;
  /** Absolute data directory. */
  dataDir: string;
}

export function renderProjectFile(config: ProjectConfig): string {
  return [
    "# pharos.yaml — written by `pharos init`. Safe to commit; it contains no secrets.",
    "#",
    "# storage.backend `embedded` keeps everything under storage.dataDir with no infrastructure:",
    "# tamper-evident and offline-verifiable, NOT write-once (WORM). For retention guarantees",
    "# run the Postgres + S3 Object Lock backend — see docs/LIMITATIONS.md §8 in the repo.",
    `version: ${config.version}`,
    `tenant: ${config.tenant}`,
    "storage:",
    `  backend: ${config.storage.backend}`,
    `  dataDir: ${config.storage.dataDir}`,
    `policies:   # shipped packs: ${Object.keys(SHIPPED_PACKS).join(", ")}`,
    ...config.policies.map((p) => `  - ${p}`),
    "",
  ].join("\n");
}

/**
 * A deliberately small YAML reader: two-space-indented maps, scalar lists, `#` comments.
 * It reads what `renderProjectFile` writes (and hand edits of the same shape); it is not a
 * YAML implementation and says so when it meets something else.
 */
export function parseProjectFile(text: string): ProjectConfig {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; node: Record<string, unknown> | unknown[] }> = [
    { indent: -1, node: root },
  ];
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    if (body.startsWith("- ")) {
      if (!Array.isArray(parent))
        throw new Error(`${PROJECT_FILE}:${i + 1}: list item outside a list`);
      parent.push(scalar(body.slice(2)));
      continue;
    }
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(body);
    if (!m || Array.isArray(parent)) {
      throw new Error(
        `${PROJECT_FILE}:${i + 1}: cannot read "${body}" (only key: value, nested maps, and "- item" lists are supported)`,
      );
    }
    const [, key, value] = m;
    if (value !== undefined && value !== "") {
      parent[key!] = scalar(value);
      continue;
    }
    // A key with no value opens a map or a list; decide by peeking at the next non-empty line.
    const next = lines.slice(i + 1).find((l) => l.replace(/^#.*$/, "").trim() !== "");
    const child: Record<string, unknown> | unknown[] = next?.trim().startsWith("- ") ? [] : {};
    parent[key!] = child;
    stack.push({ indent, node: child });
  }
  return validate(root);
}

function scalar(v: string): string | number | boolean {
  const t = v.trim().replace(/^["']|["']$/g, "");
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function validate(raw: Record<string, unknown>): ProjectConfig {
  const storage = (raw.storage ?? {}) as Record<string, unknown>;
  const backend = storage.backend ?? "embedded";
  if (backend !== "embedded") {
    throw new Error(
      `${PROJECT_FILE}: storage.backend must be "embedded" (the CLI runs the zero-infrastructure backend; use the API server for postgres)`,
    );
  }
  const policies = Array.isArray(raw.policies) ? raw.policies.map(String) : [...DEFAULT_POLICIES];
  return {
    version: 1,
    tenant: typeof raw.tenant === "string" && raw.tenant ? raw.tenant : DEFAULT_TENANT,
    storage: {
      backend: "embedded",
      dataDir:
        typeof storage.dataDir === "string" && storage.dataDir ? storage.dataDir : DEFAULT_DATA_DIR,
    },
    policies,
  };
}

/** Read a file or return null if it does not exist — no check-then-use race. */
export function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

/** Resolve the project's `policies:` list to shipped pack artifacts; unknown names fail loudly. */
export function projectPolicies(project: Project): PolicyArtifact[] {
  return project.config.policies.map((name) => {
    const pack = SHIPPED_PACKS[name];
    if (!pack) {
      throw new Error(
        `${PROJECT_FILE} lists unknown policy pack "${name}" (shipped: ${Object.keys(SHIPPED_PACKS).join(", ")})`,
      );
    }
    return pack;
  });
}

export function findProject(cwd = process.cwd()): Project | null {
  let dir = resolve(cwd);
  for (;;) {
    const file = join(dir, PROJECT_FILE);
    const text = readIfPresent(file);
    if (text !== null) {
      const config = parseProjectFile(text);
      const dataDir = isAbsolute(config.storage.dataDir)
        ? config.storage.dataDir
        : join(dir, config.storage.dataDir);
      return { root: dir, file, config, dataDir };
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireProject(cwd = process.cwd()): Project {
  const project = findProject(cwd);
  if (!project) {
    throw new Error(`no ${PROJECT_FILE} found here or above — run \`pharos init\` first`);
  }
  return project;
}

/** Add the data directory to .gitignore once; the directory holds a keystore and its passphrase. */
export function ensureGitignored(root: string, dataDir: string): boolean {
  const file = join(root, ".gitignore");
  const entry = `${dataDir.replace(/\/$/, "")}/`;
  const existing = readIfPresent(file) ?? "";
  if (existing.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === dataDir)) return false;
  const block = `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}# Pharos embedded data (SQLite, record files, local keystore + passphrase) — never commit\n${entry}\n`;
  if (existing) appendFileSync(file, block);
  else writeFileSync(file, block);
  return true;
}
