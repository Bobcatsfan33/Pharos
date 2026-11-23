import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The publish order exists in two places that must agree: scripts/release-order.sh, which the
 * dry-run rehearses and the publish script enforces, and docs/PUBLISHING.md, which is what a
 * maintainer reads at 2am before an irreversible registry write. A doc that disagrees with the
 * script is worse than no doc, so the agreement is a test rather than a convention.
 */

const orderScript = readFileSync("scripts/release-order.sh", "utf8");
const publishingDoc = readFileSync("docs/PUBLISHING.md", "utf8");

/** Package names from a `NAME=(...)` bash array, in declaration order. */
function arrayEntries(source: string, name: string): readonly string[] {
  const block = new RegExp(`${name}=\\(([^)]*)\\)`, "m").exec(source);
  expect(block, `${name} must be declared in scripts/release-order.sh`).not.toBeNull();
  return (block as RegExpExecArray)[1]
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The ordered artifact column of the "Publish order" table in docs/PUBLISHING.md. */
function documentedOrder(): readonly string[] {
  const rows = publishingDoc
    .split("\n")
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  return rows.map((cells) => {
    const artifact = /`([^`]+)`/.exec(cells[2] ?? "");
    expect(artifact, `row "${cells[2]}" must name its artifact in backticks`).not.toBeNull();
    return (artifact as RegExpExecArray)[1];
  });
}

describe("publish order", () => {
  it("declares every publishable artifact in dependency order", () => {
    const npm = arrayEntries(orderScript, "NPM_PACKAGES").map((entry) => entry.split("|")[1]);
    expect(npm).toEqual([
      "@getpharos/pdp-spec",
      "@getpharos/sdk",
      "@getpharos/middleware",
      "@getpharos/cli",
    ]);
  });

  it("matches the order documented in docs/PUBLISHING.md", () => {
    const npm = arrayEntries(orderScript, "NPM_PACKAGES").map((entry) => entry.split("|")[1]);
    const python = arrayEntries(orderScript, "PY_DISTS").map((entry) => entry.split("|")[0]);
    // The doc names the PyPI distribution names; the script names source directories.
    const pypiNames = python.map((dir) => (dir === "sdks/python" ? "getpharos" : "pharos-runtime"));
    expect(documentedOrder()).toEqual([...npm, ...pypiNames]);
  });

  it("numbers the documented rows consecutively from 1", () => {
    const numbers = publishingDoc
      .split("\n")
      .filter((line) => /^\| \d+ \|/.test(line))
      .map((line) => Number(line.split("|")[1].trim()));
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  it("keeps a repository-variable gate documented for every npm package", () => {
    const gates = readFileSync("scripts/release-publish.sh", "utf8");
    for (const pkg of arrayEntries(orderScript, "NPM_PACKAGES").map((e) => e.split("|")[1])) {
      const gate = new RegExp(`"${pkg.replace("/", "\\/")}"\\)\\s*echo "([A-Z_]+)"`).exec(gates);
      expect(gate, `${pkg} must have a gate variable in release-publish.sh`).not.toBeNull();
      expect(publishingDoc).toContain((gate as RegExpExecArray)[1]);
    }
  });
});
