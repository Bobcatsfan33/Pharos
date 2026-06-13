import type { PolicyArtifact } from "../rules.js";

/**
 * HIPAA pack v2 — citation-level rules. PHI-in-context detection via the Tier-3 judge,
 * minimum-necessary evaluation, authorization-state awareness, and breach-notification
 * triggers. (Reviewed by a healthcare-privacy consultant is the external content gate.)
 */
export const HIPAA_PACK_V2: PolicyArtifact = {
  packId: "hipaa",
  version: "2.0.0",
  title: "HIPAA Privacy & Security",
  changelog: "v2: minimum-necessary, PHI-in-context via Tier-3, authorization-state, breach triggers.",
  rules: [
    {
      ruleId: "hipaa-phi-exposure",
      pack: "hipaa",
      clause: "45 CFR 164.502(b) (minimum necessary)",
      description:
        "Uses and disclosures must be limited to the minimum necessary. The Tier-3 judge detected identifiable health information in the message context; disclosure is escalated for privacy-officer review.",
      when: { judge: "phi-in-context", gte: 0.5 },
      decision: "escalate",
    },
    {
      ruleId: "hipaa-phi-external-block",
      pack: "hipaa",
      clause: "45 CFR 164.508 (authorization)",
      description:
        "Disclosure of PHI to an external recipient without authorization is prohibited. High PHI probability on an outbound external send is blocked pending authorization.",
      when: { all: [{ judge: "phi-in-context", gte: 0.8 }, { field: "action.type", op: "startsWith", value: "email." }] },
      decision: "block",
    },
    {
      ruleId: "hipaa-breach-trigger",
      pack: "hipaa",
      clause: "45 CFR 164.400-414 (breach notification)",
      description:
        "Unauthorized disclosure of PHI to an external party may constitute a breach requiring notification. Such events are escalated to trigger the breach-assessment workflow.",
      when: { all: [{ judge: "phi-in-context", gte: 0.6 }, { field: "action.type", op: "contains", value: "export" }] },
      decision: "escalate",
    },
  ],
};
