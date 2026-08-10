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

  it("does not allow a required external gate to become non-blocking", () => {
    const result = verifyMutation((document) => {
      document.externalGates[0].blocking = false;
    });
    expect(result).toContain("gate ENG-JUDGES.blocking must equal true");
  });

  it("requires the complete external gate set and a pinned assessed commit", () => {
    const missingGate = verifyMutation((document) => {
      document.externalGates.pop();
    });
    expect(missingGate).toContain("external gate ids must equal");

    const unpinned = verifyMutation((document) => {
      document.assessment.assessedCommit = "main";
    });
    expect(unpinned).toContain("assessment.assessedCommit must be a full lowercase Git commit");
  });

  it("requires an accountable tracker in this repository for every gate", () => {
    const missing = verifyMutation((document) => {
      document.externalGates[0].trackingIssues = [];
    });
    expect(missing).toContain("gate ENG-JUDGES.trackingIssues must not be empty");

    const foreign = verifyMutation((document) => {
      document.externalGates[0].trackingIssues = ["https://github.com/example/project/issues/1"];
    });
    expect(foreign).toContain("must reference this repository's GitHub issues");
  });

  it("rejects evidence receipt claims while a gate remains open", () => {
    const result = verifyMutation((document) => {
      document.externalGates[0].evidenceReceipt = "docs/enterprise-readiness.json";
    });
    expect(result).toContain("open gate ENG-JUDGES must set evidenceReceipt to null");
  });

  it("rejects completion without a gate-specific external evidence receipt", () => {
    const result = verifyMutation((document) => {
      const gate = document.externalGates[0];
      gate.status = "complete";
      gate.evidence = ["docs/enterprise-readiness.json"];
      gate.evidenceReceipt = "docs/enterprise-readiness.json";
      gate.completion = {
        approvedBy: {
          identity: "independent-approver",
          role: "Approval authority",
          organization: "External assessor",
        },
        completedAt: "2026-08-10",
        decisionRecord: "docs/enterprise-readiness.json",
      };
    });
    expect(result).toContain("gate ENG-JUDGES.evidenceReceipt");
  });
});
