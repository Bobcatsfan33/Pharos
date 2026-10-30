import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attenuateMandateToken,
  authorityNarrows,
  effectiveAuthority,
  ephemeralKeyFromSeed,
  verifyMandateToken,
  type AttenuationCheck,
  type EffectiveAuthority,
  type MandateToken,
  type PublicKeyEntry,
} from "@pharos/core";

/**
 * The two properties the handoff asks for:
 *   1. effective(attenuate(t)) ⊆ effective(t) for random attenuation chains.
 *   2. Fuzz: no mutation of a valid token can widen effective() — every mutated token either
 *      fails verification or has an effective authority that still narrows the original.
 */
const fixture = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as {
  keyset: PublicKeyEntry[];
  vectors: Array<{ name: string; now: string; token: MandateToken }>;
};
const root = fixture.keyset.find((k) => k.keyId === "mandate:acme#v1")!;
const base = fixture.vectors.find((v) => v.name === "authority-only")!;
const now = new Date(base.now);

/** Small deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;

function randomNarrowingCheck(r: () => number, eff: EffectiveAuthority): AttenuationCheck | null {
  const kind = pick(r, ["limit", "expiry", "scope"] as const);
  if (kind === "limit") {
    const cur = eff.limits.financialAmount ?? 100000;
    return {
      kind,
      value: {
        financialAmount: Math.floor(cur * r()),
        ...(r() < 0.3 ? { reversibility: pick(r, ["reversible", "irreversible"] as const) } : {}),
      },
    };
  }
  if (kind === "expiry") {
    const cur = new Date(eff.expiresAt).getTime();
    const earlier = new Date(now.getTime() + 1000 + r() * Math.max(0, cur - now.getTime() - 1000));
    return { kind, value: earlier.toISOString() };
  }
  // scope: keep a random non-empty subset, or specialise a prefix to a concrete type under it
  const candidates = eff.scope.actionTypes.flatMap((p) =>
    p.endsWith(".") ? [p, `${p}transfer`, `${p}refund`] : [p],
  );
  const chosen = candidates.filter(() => r() < 0.6);
  if (chosen.length === 0) return null;
  return { kind, value: { actionTypes: chosen } };
}

describe("MandateToken properties", () => {
  it("effective(attenuate(t)) ⊆ effective(t) over 200 random chains", () => {
    const r = rng(42);
    for (let i = 0; i < 200; i++) {
      let t = base.token;
      let prev = effectiveAuthority(t);
      const depth = 1 + Math.floor(r() * 5);
      for (let d = 0; d < depth; d++) {
        const checks: AttenuationCheck[] = [];
        for (let c = 0; c < 1 + Math.floor(r() * 3); c++) {
          const ck = randomNarrowingCheck(r, effectiveAuthority(t));
          if (ck) checks.push(ck);
        }
        let next: MandateToken;
        try {
          next = attenuateMandateToken(
            t,
            { checks, issuedAt: now.toISOString() },
            ephemeralKeyFromSeed(Buffer.alloc(32, (i * 7 + d) & 0xff)),
          );
        } catch (err) {
          // Random checks may collide (e.g. reversibility already fixed); that must be a refusal, never a widening.
          expect((err as Error).message).toMatch(/widens|must/);
          continue;
        }
        const eff = effectiveAuthority(next);
        expect(authorityNarrows(eff, prev), `chain ${i} depth ${d}`).toBe(true);
        expect(authorityNarrows(eff, effectiveAuthority(base.token))).toBe(true);
        const v = verifyMandateToken(next, root, now);
        expect(v.ok, `${i}/${d}: ${v.errors.join("; ")}`).toBe(true);
        expect(v.effective).toEqual(eff);
        prev = eff;
        t = next;
      }
    }
  });

  it("fuzz: 1,500 random mutations of a valid token never widen its effective authority", () => {
    const valid = fixture.vectors.find((v) => v.name === "valid-chain")!;
    const original = verifyMandateToken(valid.token, root, now);
    expect(original.ok).toBe(true);
    const r = rng(7);
    const json = JSON.stringify(valid.token);
    const codes = new Map<string, number>();
    for (let i = 0; i < 1500; i++) {
      // Every field of a token is covered by a signature or is the proof, so a mutation that
      // actually changes bytes must be refused. The mutator loops until it changed something.
      let mutated: unknown;
      do mutated = mutate(r, JSON.parse(json));
      while (JSON.stringify(mutated) === json);
      let res;
      try {
        res = verifyMandateToken(mutated as MandateToken, root, now);
      } catch (err) {
        throw new Error(`verify threw on mutation ${i}: ${(err as Error).message}`, { cause: err });
      }
      if (res.ok) {
        // Defence in depth: should an edit ever slip through, it must still narrow.
        expect(authorityNarrows(res.effective!, original.effective!), `mutation ${i} widened`).toBe(
          true,
        );
        expect.fail(`mutation ${i} was accepted: ${JSON.stringify(mutated)}`);
      }
      expect(res.effective).toBeNull();
      codes.set(res.code!, (codes.get(res.code!) ?? 0) + 1);
    }
    // The refusals are spread across the structural checks, not all caught by one shape rule.
    expect([...codes.keys()].length).toBeGreaterThanOrEqual(4);
  });
});

/** Apply one random structural or value mutation anywhere in the token. */
function mutate(r: () => number, t: Record<string, unknown>): unknown {
  const paths: string[][] = [];
  const walk = (v: unknown, path: string[]) => {
    paths.push(path);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, String(i)]));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(t, []);
  const path = pick(
    r,
    paths.filter((p) => p.length > 0),
  );
  const parent = path
    .slice(0, -1)
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], t) as Record<string, unknown> &
    unknown[];
  const key = path[path.length - 1]!;
  const cur = (parent as Record<string, unknown>)[key];
  const op = r();
  let next: unknown;
  if (op < 0.2) next = undefined;
  else if (op < 0.4) next = typeof cur === "number" ? cur * (r() < 0.5 ? 10 : -1) + 1 : cur;
  else if (op < 0.6) next = typeof cur === "string" ? (r() < 0.5 ? `${cur}x` : cur.slice(1)) : cur;
  else if (op < 0.7)
    next = Array.isArray(cur)
      ? [...cur, pick(r, ["*", "wire.", "payment.", "2099-01-01T00:00:00.000Z"])]
      : cur;
  else if (op < 0.8) next = Array.isArray(cur) ? cur.slice(0, -1) : cur;
  else if (op < 0.9)
    next =
      cur && typeof cur === "object"
        ? { ...(cur as object), financialAmount: 999999, actionTypes: ["*"] }
        : cur;
  else next = pick(r, [null, 0, "", "*", 1e9, [], {}]);
  if (next === undefined) {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
  } else if (Array.isArray(parent)) parent[Number(key)] = next;
  else (parent as Record<string, unknown>)[key] = next;
  return t;
}
