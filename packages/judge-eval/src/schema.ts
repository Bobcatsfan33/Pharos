import { sha256Hex } from "@pharos/core";

/**
 * Stable, versioned schema for the judge-eval datasets.
 *
 * The committed JSON datasets + their content hashes are the source of truth (roadmap §7-10(f));
 * this schema is what a scorer/loader binds to and must not change shape without a version bump.
 */
export const EVAL_SCHEMA_VERSION = "1.0.0" as const;

/** The three domain concerns evaluated, matching the served judge packIds. */
export type Concern = "finra-promissory" | "phi-in-context" | "funds-movement-intent";
export const CONCERNS: readonly Concern[] = [
  "finra-promissory",
  "phi-in-context",
  "funds-movement-intent",
] as const;

export type Lang = "en" | "es" | "de";

/**
 * The clean/adversarial split a record belongs to. `clean-positive`/`clean-negative` are the
 * held-out clean splits; the rest are adversarial suites. `hardness` marks near-miss negatives.
 */
export type Suite =
  | "clean-positive"
  | "clean-negative"
  | "paraphrase"
  | "synonym"
  | "leetspeak"
  | "base64"
  | "rot13"
  | "sentence-split"
  | "prompt-injection"
  | "spanish"
  | "german";

export const ADVERSARIAL_SUITES: readonly Suite[] = [
  "paraphrase",
  "synonym",
  "leetspeak",
  "base64",
  "rot13",
  "sentence-split",
  "prompt-injection",
  "spanish",
  "german",
] as const;

export interface EvalExample {
  /** Deterministic id: `<concern>/<suite>/<lang>/<index>`. */
  id: string;
  concern: Concern;
  suite: Suite;
  lang: Lang;
  /** 1 = the concern is present (an examiner would flag it); 0 = absent. */
  label: 0 | 1;
  /** Near-miss hard negative (only meaningful for label 0). */
  hardNegative: boolean;
  /** Taxonomy class for a hard negative (metadata; excluded from the content hash). */
  nearMissClass?: string;
  text: string;
  /** Provenance: the authored template id this example expanded from. */
  templateId: string;
  /** Provenance: the cited authority tag grounding the label (see SOURCES). */
  source: string;
}

export interface EvalSplit {
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  concern: Concern;
  suite: Suite;
  lang: Lang;
  count: number;
  positives: number;
  hardNegatives: number;
  examples: EvalExample[];
}

/** Canonical content hash of a split — hashes only the label-bearing content, not counts. */
export function splitContentHash(split: Pick<EvalSplit, "examples">): string {
  return sha256Hex(
    split.examples.map((e) => ({
      id: e.id,
      concern: e.concern,
      suite: e.suite,
      lang: e.lang,
      label: e.label,
      hardNegative: e.hardNegative,
      text: e.text,
    })),
  );
}

export interface SplitManifestEntry {
  suite: Suite;
  lang: Lang;
  file: string;
  count: number;
  positives: number;
  hardNegatives: number;
  contentHash: string;
}

export interface ConcernManifest {
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  concern: Concern;
  /** Deterministic generator seed (provenance, not a bit-identical-regen promise — §7-10(f)). */
  seed: number;
  generator: {
    kind: "template-expansion";
    author: string;
    /** Set by the CLI at generation time and committed; not recomputed on load. */
    generatedAt: string;
    note: string;
  };
  sources: Record<string, string>;
  taxonomy: NearMissTaxonomy;
  splits: SplitManifestEntry[];
  humanReview: HumanReviewRecord;
  /** Aggregate content hash over every split's contentHash (the dataset's version). */
  datasetHash: string;
}

export interface NearMissClass {
  id: string;
  description: string;
  /** Target minimum count of this near-miss class in the clean-negative split. */
  target: number;
}

export interface NearMissTaxonomy {
  concern: Concern;
  /** Minimum fraction of the negative split that must be hard negatives (§7-10(a)). */
  minHardNegativeFraction: number;
  classes: NearMissClass[];
}

/** Stratified human-review record (§7-10(a)); populated by the reviewer, not the generator. */
export interface HumanReviewRecord {
  status: "pending-qualified-review" | "reviewed";
  reviewer: string | null;
  qualification: string | null;
  reviewedAt: string | null;
  /** Deterministic 10% sample method description. */
  sampleMethod: string;
  fractionReviewed: number;
  corrections: number;
  agreementRate: number | null;
  notes: string;
}
