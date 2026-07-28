import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { type AsyncJudge, loadOnnxJudge } from "./onnxModel.js";

/**
 * Served-judge readiness gate (WS6 / roadmap S6-T3). Fail-CLOSED: the server must not report ready
 * until EVERY registered served pack has (1) its artifact fetched + sha256-verified against the
 * manifest, (2) an ONNX session constructed, (3) one warm inference completed, and (4) a model card
 * whose version hash matches the served version. Any failure ⇒ not ready.
 *
 * Deps are injectable so the gate is unit-testable without downloading a model.
 */
export interface JudgeReadinessCheck {
  packId: string;
  version: string | null;
  loaded: boolean;
  warmInferenceOk: boolean;
  cardVersion: string | null;
  cardMatches: boolean;
  passed: boolean;
  error?: string;
}

export interface JudgeReadinessResult {
  ready: boolean;
  checks: JudgeReadinessCheck[];
}

export const MODELS_DIR = fileURLToPath(new URL("../models", import.meta.url));

/** Parse the `Version:` line from a pack's model card, or null if the card is missing/malformed. */
export function readCardVersion(concern: string, modelsDir: string = MODELS_DIR): string | null {
  try {
    const card = readFileSync(join(modelsDir, `${concern}.CARD.md`), "utf8");
    const m = card.match(/\*\*Version:\*\*\s*`([^`]+@[0-9a-f]{12})`/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export interface ReadinessDeps {
  loadJudge: (concern: string) => Promise<AsyncJudge>;
  readCardVersion: (concern: string) => string | null;
}

const DEFAULT_DEPS: ReadinessDeps = {
  loadJudge: (concern) => loadOnnxJudge({ concern }),
  readCardVersion: (concern) => readCardVersion(concern),
};

/**
 * Check readiness of every served pack. `ready` is true only if EVERY check passes (fail-closed).
 * A pack that throws on load/inference, or whose card is missing/mismatched, fails and blocks ready.
 */
export async function checkJudgeReadiness(
  concerns: string[],
  deps: Partial<ReadinessDeps> = {},
): Promise<JudgeReadinessResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const checks: JudgeReadinessCheck[] = [];
  for (const packId of concerns) {
    const check: JudgeReadinessCheck = {
      packId,
      version: null,
      loaded: false,
      warmInferenceOk: false,
      cardVersion: null,
      cardMatches: false,
      passed: false,
    };
    try {
      const judge = await d.loadJudge(packId);
      check.loaded = true;
      check.version = judge.version();
      // Warm inference: exercise the full tokenize → infer → probability path once.
      const [result] = await judge.scoreBatch(["readiness warm inference"]);
      check.warmInferenceOk =
        typeof result?.probability === "number" && Number.isFinite(result.probability);
      check.cardVersion = d.readCardVersion(packId);
      check.cardMatches = check.cardVersion !== null && check.cardVersion === check.version;
      check.passed = check.loaded && check.warmInferenceOk && check.cardMatches;
    } catch (err) {
      check.error = (err as Error).message;
    }
    checks.push(check);
  }
  return { ready: checks.length > 0 && checks.every((c) => c.passed), checks };
}
