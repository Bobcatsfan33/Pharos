/**
 * MandateToken verification for SDK holders (Workstream A).
 *
 * Standalone on purpose — `@getpharos/sdk` has no workspace dependencies — and byte-for-byte
 * the same rules as `@pharos/core/mandate-token`: canonical JSON (sorted keys, no whitespace,
 * `JSON.stringify` scalars), SHA-256, domain-separated position-bound signing messages, and
 * the narrowing algebra. Uses WebCrypto so it runs in Node ≥ 20 and modern browsers; an
 * Ed25519 root (local KMS) and an ECDSA P-256 root (AWS KMS, DER signatures) are both
 * supported. The conformance vectors in packages/core/test/mandate-token/vectors.json are
 * the contract.
 */

export type ReversibilityLimit = "reversible" | "irreversible" | "any";
export interface MandateScope {
  actionTypes: string[];
  resources: string[];
}
export interface MandateLimits {
  financialAmount?: number;
  currency?: string;
  reversibility?: ReversibilityLimit;
}
export interface MandateAuthority {
  tenantId: string;
  agentId: string;
  mandateId: string;
  grantor: string;
  issuedAt: string;
  expiresAt: string;
  scope: MandateScope;
  limits: MandateLimits;
  citations: string[];
  keyId: string;
  nextKey: string;
}
export type AttenuationCheck =
  | { kind: "limit"; value: MandateLimits }
  | { kind: "expiry"; value: string }
  | { kind: "scope"; value: Partial<MandateScope> };
export interface AttenuationBlock {
  checks: AttenuationCheck[];
  issuedAt: string;
  nextKey: string;
}
export type TokenProof = { kind: "next"; secret: string } | { kind: "sealed"; signature: string };
export interface MandateToken {
  v: 1;
  authority: MandateAuthority;
  blocks: AttenuationBlock[];
  signatures: string[];
  proof: TokenProof;
}
export type EffectiveAuthority = Omit<MandateAuthority, "nextKey" | "keyId">;
/** A published keyset entry: base64 SPKI DER public key and its algorithm. */
export interface MandateRootKey {
  keyId: string;
  publicKey: string;
  algorithm: "ed25519" | "ecdsa-p256";
}
export type MandateTokenVerifyCode =
  | "malformed"
  | "too-many-blocks"
  | "root-key-mismatch"
  | "root-key-unknown"
  | "root-signature"
  | "block-signature"
  | "key-reuse"
  | "widening"
  | "proof"
  | "expired"
  | "tenant-mismatch"
  | "agent-mismatch";
export interface MandateTokenVerifyResult {
  ok: boolean;
  code: MandateTokenVerifyCode | null;
  errors: string[];
  effective: EffectiveAuthority | null;
  blockHashes: string[];
  headHash: string;
}

export const MANDATE_TOKEN_MAX_BLOCKS = 16;
const AUTHORITY_DOMAIN = "pharos:mandate-token:v1:authority";
const BLOCK_DOMAIN = "pharos:mandate-token:v1:block";
const SEAL_DOMAIN = "pharos:mandate-token:v1:seal";

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (mirrors packages/core/src/chain/canonical.ts)
// ---------------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) throw new Error("Cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "undefined" || t === "function")
    throw new Error(`Cannot canonicalize value of type ${t}`);
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new Error(`Cannot canonicalize value of type ${t}`);
}

const enc = new TextEncoder();

/** A fresh ArrayBuffer-backed copy, so WebCrypto's BufferSource typing is satisfied everywhere. */
function bytes(u8: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (u8 instanceof ArrayBuffer) return u8;
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}
function text(s: string): ArrayBuffer {
  return bytes(enc.encode(s));
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this runtime");
  return c.subtle;
}

async function sha256Hex(value: unknown): Promise<string> {
  const digest = await subtle().digest("SHA-256", text(canonicalJson(value)));
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Signatures: Ed25519 raw keys (ephemeral) and keyset entries (root).
// ---------------------------------------------------------------------------

async function verifyEd25519Raw(
  publicKey: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const raw = fromBase64(publicKey);
  if (raw.length !== 32) return false;
  try {
    const key = await subtle().importKey("raw", bytes(raw), { name: "Ed25519" }, false, ["verify"]);
    return await subtle().verify("Ed25519", key, bytes(fromBase64(signature)), text(message));
  } catch {
    return false;
  }
}

/** DER ECDSA signature (r, s INTEGERs) → IEEE P1363 r||s, which WebCrypto expects. */
function derToP1363(der: Uint8Array, size = 32): Uint8Array | null {
  if (der[0] !== 0x30) return null;
  let i = 2;
  if (der[1]! & 0x80) i = 2 + (der[1]! & 0x7f);
  const read = (): Uint8Array | null => {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1]!;
    const start = i + 2;
    i = start + len;
    let v = der.subarray(start, start + len);
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) return null;
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = read();
  const s = read();
  if (!r || !s) return null;
  const out = new Uint8Array(size * 2);
  out.set(r, 0);
  out.set(s, size);
  return out;
}

async function verifyRoot(
  root: MandateRootKey,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    const spki = fromBase64(root.publicKey);
    const sig = fromBase64(signature);
    if (root.algorithm === "ecdsa-p256") {
      const key = await subtle().importKey(
        "spki",
        bytes(spki),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const p1363 = derToP1363(sig);
      if (!p1363) return false;
      return await subtle().verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        bytes(p1363),
        text(message),
      );
    }
    const key = await subtle().importKey("spki", bytes(spki), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await subtle().verify("Ed25519", key, bytes(sig), text(message));
  } catch {
    return false;
  }
}

async function ed25519PublicKeyOf(secret: string): Promise<string | null> {
  const seed = fromBase64(secret);
  if (seed.length !== 32) return null;
  try {
    const pkcs8 = new Uint8Array(16 + 32);
    pkcs8.set(fromBase64("MC4CAQAwBQYDK2VwBCIEIA=="), 0); // 302e020100300506032b657004220420
    pkcs8.set(seed, 16);
    const priv = await subtle().importKey("pkcs8", bytes(pkcs8), { name: "Ed25519" }, true, [
      "sign",
    ]);
    const jwk = await subtle().exportKey("jwk", priv);
    return toBase64(fromBase64(jwk.x!));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Narrowing algebra (mirrors core/mandate-token/codec.ts)
// ---------------------------------------------------------------------------

const REVERSIBILITY = new Set(["reversible", "irreversible", "any"]);
const isIsoDate = (s: unknown): s is string =>
  typeof s === "string" && Number.isFinite(new Date(s).getTime());
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function actionPatternCovered(narrow: string, wide: string[]): boolean {
  return wide.some((w) => w === "*" || w === narrow || (w.endsWith(".") && narrow.startsWith(w)));
}
function resourcePatternCovered(narrow: string, wide: string[]): boolean {
  return wide.some(
    (w) => w === "*" || w === narrow || (w.endsWith("*") && narrow.startsWith(w.slice(0, -1))),
  );
}
export function scopeAllowsActionType(scope: MandateScope, actionType: string): boolean {
  return scope.actionTypes.some(
    (p) => p === "*" || (p.endsWith(".") ? actionType.startsWith(p) : p === actionType),
  );
}

class Widening extends Error {}

function applyCheck(cur: EffectiveAuthority, check: AttenuationCheck): EffectiveAuthority {
  if (!isRecord(check)) throw new Widening("check must be an object");
  if (check.kind === "limit") {
    const next = check.value;
    if (!isRecord(next)) throw new Widening("limit check must be an object");
    const out: MandateLimits = { ...cur.limits };
    if (next.financialAmount !== undefined) {
      if (
        typeof next.financialAmount !== "number" ||
        !Number.isFinite(next.financialAmount) ||
        next.financialAmount < 0
      )
        throw new Widening("limit.financialAmount must be a finite number ≥ 0");
      if (
        cur.limits.financialAmount !== undefined &&
        next.financialAmount > cur.limits.financialAmount
      )
        throw new Widening(
          `limit.financialAmount ${next.financialAmount} widens ${cur.limits.financialAmount}`,
        );
      out.financialAmount = next.financialAmount;
    }
    if (next.currency !== undefined) {
      if (typeof next.currency !== "string" || !next.currency)
        throw new Widening("limit.currency must be a string");
      if (cur.limits.currency !== undefined && next.currency !== cur.limits.currency)
        throw new Widening(`limit.currency ${next.currency} widens ${cur.limits.currency}`);
      out.currency = next.currency;
    }
    if (next.reversibility !== undefined) {
      const rev = next.reversibility as ReversibilityLimit;
      if (!REVERSIBILITY.has(rev)) throw new Widening("limit.reversibility invalid");
      const c = cur.limits.reversibility ?? "any";
      if (c !== "any" && rev !== c) throw new Widening(`limit.reversibility ${rev} widens ${c}`);
      out.reversibility = rev;
    }
    return { ...cur, limits: out };
  }
  if (check.kind === "expiry") {
    if (!isIsoDate(check.value)) throw new Widening("expiry check must be an ISO date");
    if (new Date(check.value).getTime() > new Date(cur.expiresAt).getTime())
      throw new Widening(`expiry ${check.value} widens ${cur.expiresAt}`);
    return { ...cur, expiresAt: check.value };
  }
  if (check.kind === "scope") {
    const next = check.value;
    if (!isRecord(next)) throw new Widening("scope check must be an object");
    const out: MandateScope = {
      actionTypes: [...cur.scope.actionTypes],
      resources: [...cur.scope.resources],
    };
    if (next.actionTypes !== undefined) {
      if (!isStringList(next.actionTypes)) throw new Widening("scope.actionTypes must be strings");
      for (const p of next.actionTypes)
        if (!actionPatternCovered(p, cur.scope.actionTypes))
          throw new Widening(`scope.actionTypes "${p}" widens`);
      out.actionTypes = [...next.actionTypes];
    }
    if (next.resources !== undefined) {
      if (!isStringList(next.resources)) throw new Widening("scope.resources must be strings");
      for (const p of next.resources)
        if (!resourcePatternCovered(p, cur.scope.resources))
          throw new Widening(`scope.resources "${p}" widens`);
      out.resources = [...next.resources];
    }
    return { ...cur, scope: out };
  }
  throw new Widening(`unknown check kind ${String((check as { kind: unknown }).kind)}`);
}

function toEffective(a: MandateAuthority): EffectiveAuthority {
  return {
    tenantId: a.tenantId,
    agentId: a.agentId,
    mandateId: a.mandateId,
    grantor: a.grantor,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    scope: { actionTypes: [...a.scope.actionTypes], resources: [...a.scope.resources] },
    limits: { ...a.limits },
    citations: [...a.citations],
  };
}

/** The intersection of the authority and every block. Throws on a widening block. */
export function effectiveAuthority(token: MandateToken): EffectiveAuthority {
  let eff = toEffective(token.authority);
  for (const b of token.blocks) for (const c of b.checks) eff = applyCheck(eff, c);
  return eff;
}

function shapeErrors(token: unknown): string[] {
  const errs: string[] = [];
  if (!isRecord(token)) return ["token is not an object"];
  if (token.v !== 1) errs.push("v must be 1");
  const a = token.authority;
  const is32 = (v: unknown) => typeof v === "string" && safeLen(v) === 32;
  if (!isRecord(a)) errs.push("authority missing");
  else {
    for (const k of ["tenantId", "agentId", "mandateId", "grantor", "keyId"])
      if (typeof a[k] !== "string" || !(a[k] as string).length) errs.push(`authority.${k} missing`);
    if (!isIsoDate(a.issuedAt)) errs.push("authority.issuedAt not a date");
    if (!isIsoDate(a.expiresAt)) errs.push("authority.expiresAt not a date");
    if (
      !isRecord(a.scope) ||
      !isStringList(a.scope.actionTypes) ||
      !isStringList(a.scope.resources)
    )
      errs.push("authority.scope malformed");
    if (!isRecord(a.limits)) errs.push("authority.limits malformed");
    if (!isStringList(a.citations)) errs.push("authority.citations malformed");
    if (!is32(a.nextKey)) errs.push("authority.nextKey not a 32-byte key");
  }
  if (!Array.isArray(token.blocks)) errs.push("blocks must be an array");
  else
    token.blocks.forEach((b, i) => {
      if (!isRecord(b)) return errs.push(`blocks[${i}] not an object`);
      if (!Array.isArray(b.checks)) errs.push(`blocks[${i}].checks must be an array`);
      if (!isIsoDate(b.issuedAt)) errs.push(`blocks[${i}].issuedAt not a date`);
      if (!is32(b.nextKey)) errs.push(`blocks[${i}].nextKey not a 32-byte key`);
    });
  if (!Array.isArray(token.signatures) || !token.signatures.every(isCanonicalBase64))
    errs.push("signatures must be canonical base64 strings");
  else if (Array.isArray(token.blocks) && token.signatures.length !== token.blocks.length + 1)
    errs.push(`signatures: expected ${token.blocks.length + 1}, got ${token.signatures.length}`);
  const p = token.proof;
  if (!isRecord(p)) errs.push("proof missing");
  else if (p.kind === "next") {
    if (!is32(p.secret)) errs.push("proof.secret not a 32-byte key");
    if (Object.keys(p).length !== 2) errs.push("proof has unexpected keys");
  } else if (p.kind === "sealed") {
    if (!isCanonicalBase64(p.signature)) errs.push("proof.signature must be canonical base64");
    if (Object.keys(p).length !== 2) errs.push("proof has unexpected keys");
  } else errs.push("proof.kind must be next | sealed");
  return errs;
}

function safeLen(b64: string): number {
  try {
    const raw = fromBase64(b64);
    return toBase64(raw) === b64 ? raw.length : -1;
  } catch {
    return -1;
  }
}

/** Canonical base64 only: a lenient decoder would let two strings name one signature. */
function isCanonicalBase64(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && safeLen(v) > 0;
}

/** `[sha256(authority), sha256(block 0), …]` — what the ActionRecord seals. */
export async function mandateTokenBlockHashes(token: MandateToken): Promise<string[]> {
  return [
    await sha256Hex(token.authority),
    ...(await Promise.all(token.blocks.map((b) => sha256Hex(b)))),
  ];
}

export async function mandateTokenHeadHash(token: MandateToken): Promise<string> {
  return sha256Hex({
    v: token.v,
    authority: token.authority,
    blocks: token.blocks,
    signatures: token.signatures,
  });
}

export interface VerifyMandateTokenOptions {
  expect?: { tenantId?: string; agentId?: string };
  maxBlocks?: number;
}

/** Pure, offline verification against the tenant's published mandate key. */
export async function verifyMandateToken(
  token: MandateToken,
  root: MandateRootKey,
  now: Date,
  opts: VerifyMandateTokenOptions = {},
): Promise<MandateTokenVerifyResult> {
  const fail = (
    code: MandateTokenVerifyCode,
    errors: string[],
    blockHashes: string[] = [],
    headHash = "",
  ): MandateTokenVerifyResult => ({
    ok: false,
    code,
    errors,
    effective: null,
    blockHashes,
    headHash,
  });
  const shape = shapeErrors(token);
  if (shape.length) return fail("malformed", shape);
  const max = opts.maxBlocks ?? MANDATE_TOKEN_MAX_BLOCKS;
  if (token.blocks.length > max)
    return fail("too-many-blocks", [`${token.blocks.length} blocks exceeds ${max}`]);
  const hashes = await mandateTokenBlockHashes(token);
  const head = await mandateTokenHeadHash(token);
  const a = token.authority;
  if (opts.expect?.tenantId !== undefined && a.tenantId !== opts.expect.tenantId)
    return fail(
      "tenant-mismatch",
      [`token tenant ${a.tenantId} ≠ ${opts.expect.tenantId}`],
      hashes,
      head,
    );
  if (opts.expect?.agentId !== undefined && a.agentId !== opts.expect.agentId)
    return fail(
      "agent-mismatch",
      [`token agent ${a.agentId} ≠ ${opts.expect.agentId}`],
      hashes,
      head,
    );
  if (root.keyId !== a.keyId)
    return fail(
      "root-key-mismatch",
      [`authority.keyId ${a.keyId} ≠ root ${root.keyId}`],
      hashes,
      head,
    );
  if (!(await verifyRoot(root, `${AUTHORITY_DOMAIN}\n${hashes[0]}`, token.signatures[0]!)))
    return fail(
      "root-signature",
      ["authority signature does not verify against the root key"],
      hashes,
      head,
    );

  let eff = toEffective(a);
  const seen = new Set<string>([a.nextKey]);
  let signer = a.nextKey;
  for (let i = 0; i < token.blocks.length; i++) {
    const block = token.blocks[i]!;
    const msg = `${BLOCK_DOMAIN}\n${i}\n${hashes[i]}\n${hashes[i + 1]}`;
    if (!(await verifyEd25519Raw(signer, msg, token.signatures[i + 1]!)))
      return fail("block-signature", [`block ${i} signature does not verify`], hashes, head);
    if (seen.has(block.nextKey))
      return fail("key-reuse", [`block ${i} republishes an ephemeral key`], hashes, head);
    seen.add(block.nextKey);
    try {
      for (const c of block.checks) eff = applyCheck(eff, c);
    } catch (err) {
      return fail("widening", [`block ${i}: ${(err as Error).message}`], hashes, head);
    }
    signer = block.nextKey;
  }
  if (token.proof.kind === "next") {
    const pub = await ed25519PublicKeyOf(token.proof.secret);
    if (pub !== signer)
      return fail("proof", ["proof.secret does not match the head's next key"], hashes, head);
  } else if (!(await verifyEd25519Raw(signer, `${SEAL_DOMAIN}\n${head}`, token.proof.signature))) {
    return fail("proof", ["seal signature does not verify"], hashes, head);
  }
  if (new Date(eff.expiresAt).getTime() <= now.getTime())
    return fail("expired", [`token expired at ${eff.expiresAt}`], hashes, head);
  return { ok: true, code: null, errors: [], effective: eff, blockHashes: hashes, headHash: head };
}

/**
 * Holder-side attenuation: append a narrowing block signed with the token's current ephemeral
 * key and move to a fresh one. The key that signed is not retained. Ed25519 via WebCrypto.
 */
export async function attenuateMandateToken(
  token: MandateToken,
  block: { checks: AttenuationCheck[]; issuedAt: string },
): Promise<MandateToken> {
  if (token.proof.kind !== "next") throw new Error("cannot attenuate a sealed token");
  let eff = effectiveAuthority(token);
  for (const c of block.checks) eff = applyCheck(eff, c);
  const s = subtle();
  const pair = (await s.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubJwk = await s.exportKey("jwk", pair.publicKey);
  const privJwk = await s.exportKey("jwk", pair.privateKey);
  const nextKey = toBase64(fromBase64(pubJwk.x!));
  const full: AttenuationBlock = {
    checks: block.checks.map((c) => ({ ...c })) as AttenuationCheck[],
    issuedAt: block.issuedAt,
    nextKey,
  };
  const hashes = await mandateTokenBlockHashes(token);
  const index = token.blocks.length;
  const msg = `${BLOCK_DOMAIN}\n${index}\n${hashes[index]}\n${await sha256Hex(full)}`;
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(fromBase64("MC4CAQAwBQYDK2VwBCIEIA=="), 0);
  pkcs8.set(fromBase64(token.proof.secret), 16);
  const signingKey = await s.importKey("pkcs8", bytes(pkcs8), { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await s.sign("Ed25519", signingKey, text(msg)));
  return {
    v: 1,
    authority: token.authority,
    blocks: [...token.blocks, full],
    signatures: [...token.signatures, toBase64(sig)],
    proof: { kind: "next", secret: toBase64(fromBase64(privJwk.d!)) },
  };
}
