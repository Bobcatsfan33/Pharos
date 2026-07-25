import type { Concern, NearMissTaxonomy } from "../schema.js";

/**
 * An authored template. The LABEL is a property of the template (grounded in a cited authority),
 * never inferred by a model from free text — this is what makes ground truth defensible
 * (§7-10(a): an LLM may not be the sole source of both an example and its accepted label).
 */
export interface Template {
  id: string;
  label: 0 | 1;
  /** For negatives: is this a near-miss hard negative? Which taxonomy class? */
  hardNegative?: boolean;
  nearMissClass?: string;
  /** Citation tag into ConcernSpec.sources grounding the label. */
  source: string;
  /** Template text with `{slot}` placeholders filled from `slots`. */
  text: string;
}

export interface ConcernSpec {
  concern: Concern;
  /** Citation tags → human-readable authority (public/redacted material only). */
  sources: Record<string, string>;
  taxonomy: NearMissTaxonomy;
  /** Slot dictionaries for combinatorial, deterministic expansion. */
  slots: Record<string, string[]>;
  positives: Template[];
  /** Near-miss negatives (label 0), each tagged with a taxonomy class. */
  hardNegatives: Template[];
  /** Unrelated easy negatives (label 0). */
  easyNegatives: Template[];
  /** Natively authored (not machine-translated) examples with real labels. */
  native: { es: Template[]; de: Template[] };
}
