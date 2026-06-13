import { describe, it, expect } from "vitest";
import {
  ActionRecordContentSchema,
  fromFlightlineEvent,
  fromLighthouseVerdict,
  toFlightlineEvent,
  toLighthouseVerdict,
} from "@pharos/core";
import { LIGHTHOUSE_DEMO } from "./fixtures/lighthouse.js";
import { FLIGHTLINE_DEMO } from "./fixtures/flightline.js";

describe("legacy migration adapters", () => {
  it("migrates the AI Lighthouse demo dataset cleanly into v1", () => {
    LIGHTHOUSE_DEMO.forEach((raw, i) => {
      const content = fromLighthouseVerdict(raw, { tenantId: "demo", sequence: i });
      // Migrated content must satisfy the frozen v1 schema.
      expect(() => ActionRecordContentSchema.parse(content)).not.toThrow();
      expect(content.schemaVersion).toBe("1.0.0");
      expect(content.sequence).toBe(i);
    });
  });

  it("migrates the Flightline demo dataset cleanly into v1", () => {
    FLIGHTLINE_DEMO.forEach((raw, i) => {
      const content = fromFlightlineEvent(raw, { sequence: i });
      expect(() => ActionRecordContentSchema.parse(content)).not.toThrow();
      expect(content.tenantId).toBe(raw.tenant);
      expect(content.liability.oversightMode).toBeDefined();
    });
  });

  it("maps Lighthouse decisions to unified verdicts", () => {
    const deny = fromLighthouseVerdict({ ...LIGHTHOUSE_DEMO[0], decision: "deny" }, { tenantId: "t", sequence: 0 });
    expect(deny.verdict.decision).toBe("block");
    const review = fromLighthouseVerdict({ ...LIGHTHOUSE_DEMO[0], decision: "review" }, { tenantId: "t", sequence: 0 });
    expect(review.verdict.decision).toBe("escalate");
    const transform = fromLighthouseVerdict({ ...LIGHTHOUSE_DEMO[0], decision: "transform" }, { tenantId: "t", sequence: 0 });
    expect(transform.verdict.decision).toBe("modify");
  });

  it("preserves Flightline mandate + blast radius round-trip", () => {
    const content = fromFlightlineEvent(FLIGHTLINE_DEMO[1], { sequence: 0 });
    const back = toFlightlineEvent(content);
    expect(back.mandate?.mandate_id).toBe(FLIGHTLINE_DEMO[1].mandate?.mandate_id);
    expect(back.impact.amount).toBe(FLIGHTLINE_DEMO[1].impact.amount);
    expect(back.impact.reversible).toBe(FLIGHTLINE_DEMO[1].impact.reversible);
  });

  it("round-trips Lighthouse verdict fields", () => {
    const content = fromLighthouseVerdict(LIGHTHOUSE_DEMO[0], { tenantId: "t", sequence: 0 });
    const back = toLighthouseVerdict(content);
    expect(back.action_type).toBe(LIGHTHOUSE_DEMO[0].action_type);
    expect(back.score).toBe(LIGHTHOUSE_DEMO[0].score);
  });
});
