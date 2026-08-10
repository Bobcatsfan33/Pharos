import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const verifier = join(repoRoot, "scripts/verify-enterprise-readiness.mjs");
const source = join(repoRoot, "docs/enterprise-readiness.json");

function verifyMutation(mutate: (document: any) => void): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-readiness-"));
  const target = join(directory, "manifest.json");
  try {
    const document = JSON.parse(readFileSync(source, "utf8"));
    mutate(document);
    writeFileSync(target, JSON.stringify(document));
    try {
      execFileSync(process.execPath, [verifier, target], { encoding: "utf8", stdio: "pipe" });
      return "accepted";
    } catch (error) {
      const failure = error as { stderr?: string };
      return failure.stderr ?? "failed without stderr";
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("enterprise readiness verifier", () => {
  it("accepts the current explicit not-approved self-assessment", () => {
    expect(() =>
      execFileSync(process.execPath, [verifier], { encoding: "utf8", stdio: "pipe" }),
    ).not.toThrow();
  });

  it("rejects evidence whose reviewed bytes no longer match", () => {
    const result = verifyMutation((document) => {
      document.evidenceSnapshot.files[0].sha256 = "0".repeat(64);
    });
    expect(result).toContain("evidence digest mismatch");
  });

  it("rejects a snapshot that omits referenced evidence", () => {
    const result = verifyMutation((document) => {
      document.evidenceSnapshot.files.pop();
    });
    expect(result).toContain("evidenceSnapshot paths must equal");
  });

  it("rejects self-approval before evaluating downstream gates", () => {
    const result = verifyMutation((document) => {
      document.assessment.deploymentDecision = "approved";
      document.assessment.approval = {
        approvedBy: document.assessment.preparedBy,
        independentOfPreparer: true,
        approvedAt: "2026-08-10",
        decisionRecord: "docs/procurement-readiness.md",
      };
    });
    expect(result).toContain("approver must be distinct from the preparer");
  });

  it("rejects invented completion metadata on an open gate", () => {
    const result = verifyMutation((document) => {
      document.externalGates[0].completion = {
        approvedBy: {
          identity: "someone-else",
          role: "Approver",
          organization: "Independent organization",
        },
        completedAt: "2026-08-10",
      };
    });
    expect(result).toContain("open gate ENG-JUDGES must set completion to null");
  });
});
