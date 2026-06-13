import type { LighthouseVerdict } from "@pharos/core";

/** AI Lighthouse legacy demo dataset (verdict plane) used to validate migration. */
export const LIGHTHOUSE_DEMO: LighthouseVerdict[] = [
  {
    verdict_id: "lh-0001",
    agent: "sales-agent",
    action_type: "email.send",
    action_payload: { subject: "Guaranteed 20% returns" },
    decision: "deny",
    tier: 3,
    citations: [{ rule: "finra-2210-promissory", source: "finra", note: "promissory language" }],
    score: 0.94,
    fallback_mode: null,
    model_id: "lh-judge-finra-v3",
    ts: "2026-02-01T10:00:00.000Z",
  },
  {
    verdict_id: "lh-0002",
    agent: "support-agent",
    action_type: "ticket.reply",
    action_payload: { body: "Thanks for reaching out" },
    decision: "allow",
    tier: 1,
    citations: [],
    score: 0.02,
    fallback_mode: null,
    model_id: null,
    ts: "2026-02-01T10:05:00.000Z",
  },
  {
    verdict_id: "lh-0003",
    agent: "ops-agent",
    action_type: "record.export",
    action_payload: { dataset: "customers" },
    decision: "review",
    tier: 2,
    citations: [{ rule: "pii-bulk-export", source: "privacy" }],
    score: 0.55,
    fallback_mode: "closed",
    model_id: null,
    ts: "2026-02-01T10:10:00.000Z",
  },
];
