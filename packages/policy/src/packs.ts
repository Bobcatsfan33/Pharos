import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuleCitation } from "@pharos/core";
import type { PolicyArtifact } from "./rules.js";

/**
 * Shipped regulation packs are data, discovered from `packages/policy/packs/*.json`.
 *
 * Adding a pack is adding a file. Nothing central lists the packs: the API, the cascade
 * and the claims-pack exporter all read this directory. Each file is validated against the
 * minimal structural contract below on load (the full JSON Schema is `pack.schema.json`,
 * used by editors and by the pack fixture test).
 */

/** How a Tier-3 concern (a judge model) is routed and what its flag means. */
export interface PackJudgeBinding {
  /** The concern / judge model id, e.g. `finra-promissory`. */
  packId: string;
  /** Action-type prefixes (`"email."`) or exact types; absent = every action type. */
  actionTypes?: string[];
  onFlag: "block" | "escalate";
  /** Only act when the action is unmandated (e.g. funds movement). */
  requireNoMandate?: boolean;
  citation: Omit<RuleCitation, "description">;
}

/** A shipped pack: a policy artifact plus the judge bindings its concerns route through. */
export interface ShippedPack extends PolicyArtifact {
  judgeBindings?: PackJudgeBinding[];
}

/** The directory of shipped pack files. */
export const DEFAULT_PACKS_DIR = fileURLToPath(new URL("../packs", import.meta.url));

export class PackLoadError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "PackLoadError";
  }
}

const PACK_ID = /^[a-z0-9][a-z0-9-]*$/;

function assertPack(file: string, value: unknown): ShippedPack {
  if (!value || typeof value !== "object") throw new PackLoadError(file, "pack must be an object");
  const pack = value as Record<string, unknown>;
  for (const key of ["packId", "version", "title"]) {
    if (typeof pack[key] !== "string" || !(pack[key] as string).length) {
      throw new PackLoadError(file, `"${key}" must be a non-empty string`);
    }
  }
  if (!PACK_ID.test(pack.packId as string)) {
    throw new PackLoadError(file, `"packId" must be lower-case kebab-case`);
  }
  if (!Array.isArray(pack.rules)) throw new PackLoadError(file, `"rules" must be an array`);
  for (const [i, rule] of (pack.rules as unknown[]).entries()) {
    const r = rule as Record<string, unknown>;
    for (const key of ["ruleId", "pack", "clause", "description"]) {
      if (typeof r?.[key] !== "string") {
        throw new PackLoadError(file, `rules[${i}].${key} must be a string`);
      }
    }
    if (!["allow", "block", "modify", "escalate"].includes(r.decision as string)) {
      throw new PackLoadError(file, `rules[${i}].decision is not a verdict decision`);
    }
    if (!r.when || typeof r.when !== "object") {
      throw new PackLoadError(file, `rules[${i}].when must be a condition`);
    }
  }
  if (pack.judgeBindings !== undefined) {
    if (!Array.isArray(pack.judgeBindings)) {
      throw new PackLoadError(file, `"judgeBindings" must be an array`);
    }
    for (const [i, binding] of (pack.judgeBindings as unknown[]).entries()) {
      const b = binding as Record<string, unknown>;
      if (typeof b?.packId !== "string") {
        throw new PackLoadError(file, `judgeBindings[${i}].packId must be a string`);
      }
      if (b.onFlag !== "block" && b.onFlag !== "escalate") {
        throw new PackLoadError(file, `judgeBindings[${i}].onFlag must be block or escalate`);
      }
      const c = b.citation as Record<string, unknown> | undefined;
      if (!c || typeof c.ruleId !== "string" || typeof c.pack !== "string") {
        throw new PackLoadError(file, `judgeBindings[${i}].citation needs ruleId and pack`);
      }
      if (b.actionTypes !== undefined && !Array.isArray(b.actionTypes)) {
        throw new PackLoadError(file, `judgeBindings[${i}].actionTypes must be an array`);
      }
    }
  }
  delete pack.$schema;
  return pack as unknown as ShippedPack;
}

/** Load every `*.json` pack in a directory, keyed by `packId`. */
export function loadShippedPacks(dir: string = DEFAULT_PACKS_DIR): Record<string, ShippedPack> {
  const packs: Record<string, ShippedPack> = {};
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const pack = assertPack(file, JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (packs[pack.packId]) {
      throw new PackLoadError(file, `duplicate packId "${pack.packId}"`);
    }
    packs[pack.packId] = pack;
  }
  return packs;
}

/** The Tier-3 judge bindings declared across a set of packs, in pack order. */
export function judgeBindingsOf(packs: Record<string, ShippedPack>): PackJudgeBinding[] {
  return Object.values(packs).flatMap((pack) => pack.judgeBindings ?? []);
}

/** The policy artifacts (rules only) of a set of packs, for the rule evaluator. */
export function artifactsOf(packs: Record<string, ShippedPack>): PolicyArtifact[] {
  return Object.values(packs).map(({ judgeBindings: _bindings, ...artifact }) => artifact);
}

/**
 * The packs shipped with this checkout, loaded once at import. Packs are versioned data: a
 * change to a rule is a change to a JSON file and a version bump, never to this module.
 */
export const SHIPPED_PACKS: Readonly<Record<string, ShippedPack>> = loadShippedPacks();
