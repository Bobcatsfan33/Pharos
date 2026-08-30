export type ApprovalDecision = "approve" | "reject";

export interface ApprovalContext {
  tenantId: string;
  actionType: string;
  riskScore: number;
  amount?: number;
  currency?: string;
  irreversible?: boolean;
  dataClasses?: string[];
  actorId: string;
}

export interface ApprovalPolicyRule {
  id: string;
  priority: number;
  actionTypes?: string[];
  minimumRiskScore?: number;
  minimumAmount?: number;
  irreversible?: boolean;
  dataClasses?: string[];
  requirement: {
    minimumApprovals: number;
    requiredRoles?: string[];
    separationOfDuties?: boolean;
    expiresInSeconds: number;
    allowBreakGlass?: boolean;
    retrospectiveReviewInSeconds?: number;
  };
}

export type ApprovalRequirement = ApprovalPolicyRule["requirement"] & {
  policyRuleId: string;
  requestedAt: string;
  expiresAt: string;
};

export interface ApprovalVote {
  subjectId: string;
  roles: string[];
  decision: ApprovalDecision;
  at: string;
  rationale?: string;
}

export interface BreakGlassGrant {
  subjectId: string;
  roles: string[];
  at: string;
  rationale: string;
}

export interface ApprovalOutcome {
  status: "approved" | "rejected" | "pending" | "expired";
  validApprovals: number;
  missingRoles: string[];
  reasons: string[];
  retrospectiveReviewDueAt?: string;
}

function matches(rule: ApprovalPolicyRule, context: ApprovalContext): boolean {
  if (rule.actionTypes && !rule.actionTypes.includes(context.actionType)) return false;
  if (rule.minimumRiskScore !== undefined && context.riskScore < rule.minimumRiskScore)
    return false;
  if (rule.minimumAmount !== undefined && (context.amount ?? 0) < rule.minimumAmount) return false;
  if (rule.irreversible !== undefined && Boolean(context.irreversible) !== rule.irreversible)
    return false;
  if (rule.dataClasses && !rule.dataClasses.some((item) => context.dataClasses?.includes(item)))
    return false;
  return true;
}

export function resolveApprovalRequirement(
  context: ApprovalContext,
  rules: ApprovalPolicyRule[],
  requestedAt = new Date().toISOString(),
): ApprovalRequirement | undefined {
  const rule = [...rules]
    .filter((candidate) => matches(candidate, context))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
  if (!rule) return undefined;
  if (
    !Number.isInteger(rule.requirement.minimumApprovals) ||
    rule.requirement.minimumApprovals < 1
  ) {
    throw new Error(`approval rule ${rule.id} has an invalid quorum`);
  }
  const start = Date.parse(requestedAt);
  if (!Number.isFinite(start) || rule.requirement.expiresInSeconds < 1) {
    throw new Error(`approval rule ${rule.id} has an invalid expiry`);
  }
  return {
    ...rule.requirement,
    policyRuleId: rule.id,
    requestedAt,
    expiresAt: new Date(start + rule.requirement.expiresInSeconds * 1_000).toISOString(),
  };
}

export function evaluateApprovals(
  context: ApprovalContext,
  requirement: ApprovalRequirement,
  votes: ApprovalVote[],
  options: { now?: string; breakGlass?: BreakGlassGrant } = {},
): ApprovalOutcome {
  const now = options.now ?? new Date().toISOString();
  if (Date.parse(now) > Date.parse(requirement.expiresAt)) {
    return {
      status: "expired",
      validApprovals: 0,
      missingRoles: requirement.requiredRoles ?? [],
      reasons: ["approval window expired"],
    };
  }

  const grant = options.breakGlass;
  if (grant) {
    const reasons: string[] = [];
    if (!requirement.allowBreakGlass) reasons.push("break-glass is not permitted by policy");
    if (!grant.rationale.trim()) reasons.push("break-glass requires a rationale");
    if (requirement.separationOfDuties && grant.subjectId === context.actorId)
      reasons.push("initiator cannot grant break-glass approval");
    if (
      !Number.isFinite(Date.parse(grant.at)) ||
      Date.parse(grant.at) < Date.parse(requirement.requestedAt) ||
      Date.parse(grant.at) > Date.parse(now)
    )
      reasons.push("break-glass grant timestamp is outside the approval window");
    if (reasons.length === 0) {
      const dueIn = requirement.retrospectiveReviewInSeconds ?? 86_400;
      return {
        status: "approved",
        validApprovals: 1,
        missingRoles: [],
        reasons: ["break-glass approval; retrospective review required"],
        retrospectiveReviewDueAt: new Date(Date.parse(grant.at) + dueIn * 1_000).toISOString(),
      };
    }
    return {
      status: "pending",
      validApprovals: 0,
      missingRoles: requirement.requiredRoles ?? [],
      reasons,
    };
  }

  const latestBySubject = new Map<string, ApprovalVote>();
  for (const vote of votes) {
    if (
      Date.parse(vote.at) < Date.parse(requirement.requestedAt) ||
      Date.parse(vote.at) > Date.parse(now)
    )
      continue;
    const previous = latestBySubject.get(vote.subjectId);
    if (!previous || Date.parse(vote.at) > Date.parse(previous.at))
      latestBySubject.set(vote.subjectId, vote);
  }
  const current = [...latestBySubject.values()];
  if (current.some((vote) => vote.decision === "reject")) {
    return {
      status: "rejected",
      validApprovals: 0,
      missingRoles: [],
      reasons: ["a reviewer rejected the action"],
    };
  }
  const approvals = current.filter(
    (vote) =>
      vote.decision === "approve" &&
      (!requirement.separationOfDuties || vote.subjectId !== context.actorId),
  );
  const coveredRoles = new Set(approvals.flatMap((vote) => vote.roles));
  const missingRoles = (requirement.requiredRoles ?? []).filter((role) => !coveredRoles.has(role));
  const reasons: string[] = [];
  if (approvals.length < requirement.minimumApprovals)
    reasons.push(`requires ${requirement.minimumApprovals} distinct approvals`);
  if (missingRoles.length > 0) reasons.push(`missing required roles: ${missingRoles.join(", ")}`);
  return {
    status: reasons.length === 0 ? "approved" : "pending",
    validApprovals: approvals.length,
    missingRoles,
    reasons,
  };
}
