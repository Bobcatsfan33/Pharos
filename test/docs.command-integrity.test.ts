import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Docs that tell an operator to run a command are executable instructions, not prose.
// A command naming a script that does not exist is a procurement-grade defect: the
// reader concludes the evidence cannot be reproduced. This suite pins every
// `scripts/…` path referenced from markdown to a file that actually exists.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".changeset",
]);

/** Workspace roots a `pnpm --filter <pkg> exec …` command can legitimately run from. */
const WORKSPACE_GLOB_ROOTS = ["packages", "services", "apps", "sdks", "runtime"];

/**
 * Matches a repo-relative or doc-relative path into a `scripts/` directory,
 * e.g. `scripts/external-verify.ts`, `../../scripts/bench-latency.ts`.
 * Requires a known source extension so globs like `scripts/*` are not treated as files.
 */
const SCRIPT_REFERENCE =
  /(?:[\w.-]+\/)*scripts\/(?:[\w.-]+\/)?[\w.-]+\.(?:ts|mts|cts|mjs|cjs|js|py|sh)\b/g;

function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      markdownFiles(join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

function workspaceRoots(): string[] {
  const roots = [repoRoot];
  for (const group of WORKSPACE_GLOB_ROOTS) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
        roots.push(join(groupDir, entry.name));
      }
    }
  }
  return roots;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

describe("documentation command integrity", () => {
  const docs = markdownFiles(repoRoot);
  const roots = workspaceRoots();

  it("finds markdown to check", () => {
    expect(docs.length).toBeGreaterThan(20);
  });

  it("every scripts/… path referenced in markdown resolves to a real file", () => {
    const broken: string[] = [];

    for (const doc of docs) {
      const lines = readFileSync(doc, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(SCRIPT_REFERENCE)) {
          const ref = match[0];
          // A reference resolves if it exists relative to the repo root, to the
          // document's own directory, or to any workspace package root (the cwd a
          // `pnpm --filter <pkg> exec …` command documents).
          const candidates = [
            resolve(dirname(doc), ref),
            ...roots.map((root) => resolve(root, ref)),
          ];
          if (!candidates.some(isFile)) {
            broken.push(`${relative(repoRoot, doc)}:${index + 1} -> ${ref}`);
          }
        }
      });
    }

    expect(broken).toEqual([]);
  });
});
