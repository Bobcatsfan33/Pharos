import { describe, it, expect } from "vitest";
import {
  checkJudgeReadiness,
  readCardVersion,
  type AsyncJudge,
  type JudgeResult,
} from "@pharos/judge";

/**
 * Judge readiness gate (WS6): fail-CLOSED. A pack is ready only when it loads, warm-inferences, and
 * has a card whose version matches the served version. Exercised with a mock loader (no download).
 */
function mockJudge(
  packId: string,
  version: string,
  opts: { warmProb?: number; throwOnLoad?: boolean } = {},
): {
  loadJudge: (c: string) => Promise<AsyncJudge>;
} {
  return {
    loadJudge: async () => {
      if (opts.throwOnLoad) throw new Error("artifact fetch failed / sha256 mismatch");
      const judge: AsyncJudge = {
        packId,
        concern: packId,
        version: () => version,
        scoreBatch: async (texts): Promise<JudgeResult[]> =>
          texts.map(() => ({
            packId,
            concern: packId,
            judgeVersion: version,
            probability: opts.warmProb ?? 0.3,
            flagged: false,
            threshold: 0.5,
          })),
      };
      return judge;
    },
  };
}

describe("judge readiness gate (fail-closed)", () => {
  it("is READY when every pack loads, warm-inferences, and matches its card version", async () => {
    const version = "demo@abcdef012345";
    const result = await checkJudgeReadiness(["demo"], {
      ...mockJudge("demo", version),
      readCardVersion: () => version,
    });
    expect(result.ready).toBe(true);
    expect(result.checks[0]).toMatchObject({
      loaded: true,
      warmInferenceOk: true,
      cardMatches: true,
      passed: true,
    });
  });

  it("is NOT ready when a pack's card version does not match the served version", async () => {
    const result = await checkJudgeReadiness(["demo"], {
      ...mockJudge("demo", "demo@aaaaaaaaaaaa"),
      readCardVersion: () => "demo@bbbbbbbbbbbb", // stale card
    });
    expect(result.ready).toBe(false);
    expect(result.checks[0]!.cardMatches).toBe(false);
  });

  it("is NOT ready when a pack's card is missing", async () => {
    const version = "demo@abcdef012345";
    const result = await checkJudgeReadiness(["demo"], {
      ...mockJudge("demo", version),
      readCardVersion: () => null,
    });
    expect(result.ready).toBe(false);
  });

  it("is NOT ready when a pack fails to load (fetch/verify/session error)", async () => {
    const result = await checkJudgeReadiness(["demo"], {
      ...mockJudge("demo", "demo@abcdef012345", { throwOnLoad: true }),
      readCardVersion: () => "demo@abcdef012345",
    });
    expect(result.ready).toBe(false);
    expect(result.checks[0]!.error).toMatch(/sha256|fetch/);
  });

  it("is NOT ready when warm inference yields a non-finite probability", async () => {
    const version = "demo@abcdef012345";
    const result = await checkJudgeReadiness(["demo"], {
      ...mockJudge("demo", version, { warmProb: Number.NaN }),
      readCardVersion: () => version,
    });
    expect(result.ready).toBe(false);
    expect(result.checks[0]!.warmInferenceOk).toBe(false);
  });

  it("one bad pack among many blocks overall readiness (fail-closed)", async () => {
    const good = mockJudge("good", "good@111111111111");
    const bad = mockJudge("bad", "bad@222222222222", { throwOnLoad: true });
    const result = await checkJudgeReadiness(["good", "bad"], {
      loadJudge: (c) => (c === "good" ? good.loadJudge(c) : bad.loadJudge(c)),
      readCardVersion: (c) => (c === "good" ? "good@111111111111" : "bad@222222222222"),
    });
    expect(result.ready).toBe(false);
    expect(result.checks.find((c) => c.packId === "good")!.passed).toBe(true);
  });

  it("reads the real committed card versions (finra/funds/phi)", () => {
    for (const c of ["finra-promissory", "funds-movement-intent", "phi-in-context"]) {
      expect(readCardVersion(c), c).toMatch(new RegExp(`^${c}@[0-9a-f]{12}$`));
    }
  });
});
