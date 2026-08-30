import { describe, expect, it } from "vitest";
import {
  evaluateApprovals,
  resolveApprovalRequirement,
  type ApprovalPolicyRule,
} from "@pharos/review";

const rules: ApprovalPolicyRule[] = [
  {
    id: "high-value-transfer",
    priority: 100,
    actionTypes: ["funds.transfer"],
    minimumAmount: 10_000,
    requirement: {
      minimumApprovals: 2,
      requiredRoles: ["risk", "finance"],
      separationOfDuties: true,
      expiresInSeconds: 900,
      allowBreakGlass: true,
      retrospectiveReviewInSeconds: 3_600,
    },
  },
];

const context = {
  tenantId: "acme",
  actionType: "funds.transfer",
  riskScore: 0.9,
  amount: 25_000,
  actorId: "initiator",
};

describe("approval policy", () => {
  it("enforces quorum, role coverage, and separation of duties", () => {
    const requirement = resolveApprovalRequirement(context, rules, "2026-01-01T00:00:00.000Z")!;
    const pending = evaluateApprovals(
      context,
      requirement,
      [
        {
          subjectId: "initiator",
          roles: ["risk"],
          decision: "approve",
          at: "2026-01-01T00:01:00.000Z",
        },
        {
          subjectId: "reviewer-1",
          roles: ["finance"],
          decision: "approve",
          at: "2026-01-01T00:02:00.000Z",
        },
      ],
      { now: "2026-01-01T00:03:00.000Z" },
    );
    expect(pending.status).toBe("pending");
    expect(pending.missingRoles).toEqual(["risk"]);

    const approved = evaluateApprovals(
      context,
      requirement,
      [
        {
          subjectId: "reviewer-1",
          roles: ["finance"],
          decision: "approve",
          at: "2026-01-01T00:01:00.000Z",
        },
        {
          subjectId: "reviewer-2",
          roles: ["risk"],
          decision: "approve",
          at: "2026-01-01T00:02:00.000Z",
        },
      ],
      { now: "2026-01-01T00:03:00.000Z" },
    );
    expect(approved.status).toBe("approved");
  });

  it("supports controlled break-glass with a retrospective deadline", () => {
    const requirement = resolveApprovalRequirement(context, rules, "2026-01-01T00:00:00.000Z")!;
    const outcome = evaluateApprovals(context, requirement, [], {
      now: "2026-01-01T00:02:00.000Z",
      breakGlass: {
        subjectId: "incident-commander",
        roles: ["security"],
        at: "2026-01-01T00:02:00.000Z",
        rationale: "Active outage",
      },
    });
    expect(outcome.status).toBe("approved");
    expect(outcome.retrospectiveReviewDueAt).toBe("2026-01-01T01:02:00.000Z");
  });

  it("refuses a future-dated break-glass grant", () => {
    const requirement = resolveApprovalRequirement(context, rules, "2026-01-01T00:00:00.000Z")!;
    const outcome = evaluateApprovals(context, requirement, [], {
      now: "2026-01-01T00:02:00.000Z",
      breakGlass: {
        subjectId: "incident-commander",
        roles: ["security"],
        at: "2026-01-01T00:03:00.000Z",
        rationale: "Active outage",
      },
    });
    expect(outcome.status).toBe("pending");
    expect(outcome.reasons).toContain("break-glass grant timestamp is outside the approval window");
  });
});
