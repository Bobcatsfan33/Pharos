import { sha256Hex } from "@pharos/core";

/**
 * Cascade-owned input normalizer (ADR 0004: hybrid, cascade-owned — the judge models stay measured
 * BARE; the SYSTEM is normalizer + model). It defeats obfuscation the model shouldn't have to learn:
 *   - unicode canonicalization: NFKC, zero-width/BOM strip, confusable/homoglyph folding, casefold,
 *     whitespace collapse;
 *   - reversible-encoding decode: base64 runs and ROT13, so an encoded payload becomes plaintext.
 *
 * Invariants (it runs on the verdict path, on hostile input):
 *   - BOUNDED: input truncated to MAX_INPUT; decoded output capped by MAX_INPUT + MAX_EXPANSION;
 *     nesting depth ≤ MAX_NESTING (no unbounded recursion); at most MAX_VARIANTS emitted.
 *   - NEVER throws or stalls on pathological input (all decodes are try/caught).
 *   - Obfuscation can only ADD detections: the cascade scores raw AND normalized variants and takes
 *     the MORE-SEVERE verdict, so normalization can never MASK a plaintext signal.
 * `NORMALIZER_VERSION` (a content hash of the ruleset) is sealed alongside the verdict so the
 * transform is auditable and replayable.
 */
const MAX_INPUT = 100_000; // hard cap on any string we process
const MAX_EXPANSION = 4; // a decode may not expand beyond 4× its encoded run
const MAX_NESTING = 2; // decode at most 2 layers deep (nested base64, etc.)
const MAX_VARIANTS = 8; // cap the number of normalized variants per input

// Zero-width, soft-hyphen, bidi controls, BOM — invisible chars used to split tokens.
const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u2060\u2066-\u2069\uFEFF]/g;

// Curated confusable/homoglyph folds → ASCII (the common cross-script lookalike attack set).
const CONFUSABLES: Record<string, string> = {
  // Cyrillic → Latin
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ԍ: "g",
  ѡ: "w",
  // Greek → Latin
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Χ: "X",
  ο: "o",
  ν: "v",
  ρ: "p",
  α: "a",
  ϲ: "c",
  // Fullwidth Latin digits/letters (NFKC handles most, but keep a few common ones)
  "０": "0",
  "１": "1",
  "５": "5",
};

function foldConfusables(text: string): string {
  let out = "";
  for (const ch of text) out += CONFUSABLES[ch] ?? ch;
  return out;
}

/** Unicode canonical form: NFKC → strip invisibles → fold confusables → casefold → collapse ws. */
export function canonicalize(text: string): string {
  const nfkc = (s: string): string => {
    try {
      return s.normalize("NFKC");
    } catch {
      return s; // extremely malformed input — keep as-is
    }
  };
  let t = text.slice(0, MAX_INPUT);
  t = nfkc(t);
  t = t.replace(ZERO_WIDTH, "");
  // Casefold BEFORE folding confusables so a capital homoglyph (e.g. Cyrillic В → в) is folded on
  // the first pass, not the second — otherwise canonicalize would not be idempotent.
  t = t.toLowerCase();
  t = foldConfusables(t);
  // A second NFKC after casefolding makes the output a fixed point (toLowerCase can emit non-NFKC
  // sequences), so canonicalize(canonicalize(x)) === canonicalize(x).
  t = nfkc(t);
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function rot13(s: string): string {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

const B64_RUN = /[A-Za-z0-9+/]{16,}={0,2}/g;

/** Decode base64 runs to text when they round-trip and yield mostly-printable UTF-8; bounded. */
function base64Decodes(text: string): string[] {
  const out: string[] = [];
  const matches = text.match(B64_RUN);
  if (!matches) return out;
  for (const run of matches.slice(0, MAX_VARIANTS)) {
    try {
      const buf = Buffer.from(run, "base64");
      if (buf.length === 0 || buf.length > run.length * MAX_EXPANSION) continue;
      const decoded = buf.toString("utf8");
      if (decoded.length > MAX_INPUT) continue;
      // Require the decode to be reversible (a genuine base64 run) and mostly printable.
      if (buf.toString("base64").replace(/=+$/, "") !== run.replace(/=+$/, "")) continue;
      const printable = [...decoded].filter((c) => c >= " " || c === "\n" || c === "\t").length;
      if (printable / Math.max(1, decoded.length) < 0.9) continue;
      out.push(decoded);
    } catch {
      // ignore an undecodable run
    }
  }
  return out;
}

/** Reversible-encoding decode candidates (ROT13 whole-text + base64 runs), bounded + nested. */
export function decodeCandidates(text: string, depth = 0): string[] {
  if (depth >= MAX_NESTING) return [];
  const t = text.slice(0, MAX_INPUT);
  const first: string[] = [];
  const r = rot13(t);
  if (r !== t) first.push(r);
  for (const d of base64Decodes(t)) first.push(d);

  const nested: string[] = [];
  for (const c of first) {
    for (const n of decodeCandidates(c, depth + 1)) nested.push(n);
    if (first.length + nested.length >= MAX_VARIANTS) break;
  }
  return [...first, ...nested].slice(0, MAX_VARIANTS);
}

/**
 * The normalized variants for a raw input: the canonical form, plus the canonicalized form of every
 * decode candidate. Deduplicated, non-empty, capped. The cascade scores the RAW input AND these,
 * and takes the more-severe verdict.
 */
export function normalizedVariants(text: string): string[] {
  const variants = new Set<string>();
  const canon = canonicalize(text);
  if (canon) variants.add(canon);
  for (const d of decodeCandidates(text)) {
    const c = canonicalize(d);
    if (c) variants.add(c);
    if (variants.size >= MAX_VARIANTS) break;
  }
  return [...variants].slice(0, MAX_VARIANTS);
}

/** Content hash of the normalizer ruleset — sealed with the verdict for auditability/replay. */
export const NORMALIZER_VERSION = `norm@${sha256Hex({
  zeroWidth: ZERO_WIDTH.source,
  confusables: CONFUSABLES,
  bounds: { MAX_INPUT, MAX_EXPANSION, MAX_NESTING, MAX_VARIANTS },
  ops: [
    "nfkc",
    "zero-width-strip",
    "confusable-fold",
    "casefold",
    "ws-collapse",
    "rot13",
    "base64",
  ],
}).slice(0, 12)}`;
