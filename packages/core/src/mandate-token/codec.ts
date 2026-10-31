import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { sha256Hex } from "../chain/canonical.js";
import { verifyWithKeyEntry } from "../chain/verify.js";
import type { PublicKeyEntry, SigningProvider } from "../signing/provider.js";
import type {
  AttenuationBlock,
  AttenuationCheck,
  EffectiveAuthority,
  MandateAuthority,
  MandateLimits,
  MandateScope,
  MandateToken,
  RootKey,
  VerifyErrorCode,
  VerifyOptions,
  VerifyResult,
} from "./types.js";

/** Chain-length ceiling: every block costs one signature verification on the request path. */
export const MAX_BLOCKS = 16;
export const MANDATE_TOKEN_VERSION = 1 as const;

const AUTHORITY_DOMAIN = "pharos:mandate-token:v1:authority";
const BLOCK_DOMAIN = "pharos:mandate-token:v1:block";
const SEAL_DOMAIN = "pharos:mandate-token:v1:seal";
/** Stands in for the real signature during mint's shape pre-check (canonical base64 of one byte). */
const PLACEHOLDER_SIGNATURE = "AA==";

// Ed25519 DER framing for raw 32-byte keys (RFC 8410): SPKI for public, PKCS#8 for private.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

// ---------------------------------------------------------------------------
// Signing messages — domain-separated and bound to chain position.
// ---------------------------------------------------------------------------

export function authorityHash(authority: MandateAuthority): string {
  return sha256Hex(authority);
}

export function authorityMessage(authority: MandateAuthority): Buffer {
  return Buffer.from(`${AUTHORITY_DOMAIN}\n${authorityHash(authority)}`, "utf8");
}

export function blockHash(block: AttenuationBlock): string {
  return sha256Hex(block);
}

export function blockMessage(index: number, prevHash: string, block: AttenuationBlock): Buffer {
  return Buffer.from(`${BLOCK_DOMAIN}\n${index}\n${prevHash}\n${blockHash(block)}`, "utf8");
}

/** sha256 over everything but the proof: the identity of this exact chain. */
export function tokenHeadHash(token: MandateToken): string {
  return sha256Hex({
    v: token.v,
    authority: token.authority,
    blocks: token.blocks,
    signatures: token.signatures,
  });
}

export function sealMessage(headHash: string): Buffer {
  return Buffer.from(`${SEAL_DOMAIN}\n${headHash}`, "utf8");
}

/** `[sha256(authority), sha256(block 0), …]` — sealed into the ActionRecord. */
export function tokenBlockHashes(token: MandateToken): string[] {
  return [authorityHash(token.authority), ...token.blocks.map(blockHash)];
}

// ---------------------------------------------------------------------------
// Ephemeral Ed25519 keys (raw 32-byte, base64).
// ---------------------------------------------------------------------------

export interface EphemeralKeyPair {
  publicKey: string;
  secret: string;
}

export function generateEphemeralKey(): EphemeralKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwkPub = publicKey.export({ format: "jwk" });
  const jwkPriv = privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.from(jwkPub.x as string, "base64url").toString("base64"),
    secret: Buffer.from(jwkPriv.d as string, "base64url").toString("base64"),
  };
}

/** Deterministic ephemeral key from a 32-byte seed (conformance vectors). */
export function ephemeralKeyFromSeed(seed: Uint8Array): EphemeralKeyPair {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return {
    publicKey: Buffer.from(jwk.x as string, "base64url").toString("base64"),
    secret: Buffer.from(seed).toString("base64"),
  };
}

export function ephemeralPublicKeyOf(secret: string): string {
  const raw = Buffer.from(secret, "base64");
  if (raw.length !== 32) throw new Error("ephemeral secret must be 32 bytes");
  return ephemeralKeyFromSeed(raw).publicKey;
}

function signEphemeral(secret: string, message: Buffer): string {
  const raw = Buffer.from(secret, "base64");
  if (raw.length !== 32) throw new Error("ephemeral secret must be 32 bytes");
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
  return edSign(null, message, key).toString("base64");
}

function verifyEphemeral(publicKey: string, message: Buffer, signature: string): boolean {
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 32) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return edVerify(null, message, key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function verifyRoot(root: RootKey, message: Buffer, signature: string): boolean {
  try {
    if (root instanceof Uint8Array) {
      return verifyEphemeral(Buffer.from(root).toString("base64"), message, signature);
    }
    return verifyWithKeyEntry(root, message, signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scope algebra: a pattern list covers an action type / resource; one list covers another.
// ---------------------------------------------------------------------------

function actionTypeCoveredBy(pattern: string, actionType: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".")) return actionType.startsWith(pattern);
  return pattern === actionType;
}

function resourceCoveredBy(pattern: string, resource: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return resource.startsWith(pattern.slice(0, -1));
  return pattern === resource;
}

/** Is every action type matched by `narrow` also matched by some entry of `wide`? */
function actionPatternCovered(narrow: string, wide: string[]): boolean {
  return wide.some((w) => w === "*" || w === narrow || (w.endsWith(".") && narrow.startsWith(w)));
}

function resourcePatternCovered(narrow: string, wide: string[]): boolean {
  return wide.some(
    (w) => w === "*" || w === narrow || (w.endsWith("*") && narrow.startsWith(w.slice(0, -1))),
  );
}

/** Does the scope admit this action type? */
export function scopeAllowsActionType(scope: MandateScope, actionType: string): boolean {
  return scope.actionTypes.some((p) => actionTypeCoveredBy(p, actionType));
}

export function scopeAllowsResource(scope: MandateScope, resource: string): boolean {
  return scope.resources.some((p) => resourceCoveredBy(p, resource));
}

/** Is `narrow` a sub-authority of `wide`? (The property the fuzz suite asserts.) */
export function authorityNarrows(narrow: EffectiveAuthority, wide: EffectiveAuthority): boolean {
  if (narrow.tenantId !== wide.tenantId || narrow.agentId !== wide.agentId) return false;
  if (narrow.mandateId !== wide.mandateId) return false;
  if (new Date(narrow.expiresAt).getTime() > new Date(wide.expiresAt).getTime()) return false;
  if (!narrow.scope.actionTypes.every((p) => actionPatternCovered(p, wide.scope.actionTypes)))
    return false;
  if (!narrow.scope.resources.every((p) => resourcePatternCovered(p, wide.scope.resources)))
    return false;
  const wl = wide.limits;
  const nl = narrow.limits;
  if (wl.financialAmount !== undefined) {
    if (nl.financialAmount === undefined || nl.financialAmount > wl.financialAmount) return false;
  }
  if (wl.currency !== undefined && nl.currency !== wl.currency) return false;
  if (wl.reversibility !== undefined && wl.reversibility !== "any") {
    if (nl.reversibility !== wl.reversibility) return false;
  }
  return true;
}

class WideningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WideningError";
  }
}

const REVERSIBILITY = new Set(["reversible", "irreversible", "any"]);

function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && Number.isFinite(new Date(s).getTime());
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

function narrowLimits(current: MandateLimits, next: MandateLimits): MandateLimits {
  if (typeof next !== "object" || next === null || Array.isArray(next))
    throw new WideningError("limit check must be an object");
  const out: MandateLimits = { ...current };
  if (next.financialAmount !== undefined) {
    if (typeof next.financialAmount !== "number" || !Number.isFinite(next.financialAmount))
      throw new WideningError("limit.financialAmount must be a finite number");
    if (next.financialAmount < 0) throw new WideningError("limit.financialAmount must be ≥ 0");
    if (current.financialAmount !== undefined && next.financialAmount > current.financialAmount)
      throw new WideningError(
        `limit.financialAmount ${next.financialAmount} widens ${current.financialAmount}`,
      );
    out.financialAmount = next.financialAmount;
  }
  if (next.currency !== undefined) {
    if (typeof next.currency !== "string" || next.currency.length === 0)
      throw new WideningError("limit.currency must be a non-empty string");
    if (current.currency !== undefined && next.currency !== current.currency)
      throw new WideningError(`limit.currency ${next.currency} widens ${current.currency}`);
    out.currency = next.currency;
  }
  if (next.reversibility !== undefined) {
    if (!REVERSIBILITY.has(next.reversibility))
      throw new WideningError("limit.reversibility must be reversible | irreversible | any");
    const cur = current.reversibility ?? "any";
    if (cur !== "any" && next.reversibility !== cur)
      throw new WideningError(`limit.reversibility ${next.reversibility} widens ${cur}`);
    out.reversibility = next.reversibility;
  }
  return out;
}

function narrowScope(current: MandateScope, next: Partial<MandateScope>): MandateScope {
  if (typeof next !== "object" || next === null || Array.isArray(next))
    throw new WideningError("scope check must be an object");
  const out: MandateScope = {
    actionTypes: [...current.actionTypes],
    resources: [...current.resources],
  };
  if (next.actionTypes !== undefined) {
    if (!isStringList(next.actionTypes))
      throw new WideningError("scope.actionTypes must be strings");
    for (const p of next.actionTypes) {
      if (!actionPatternCovered(p, current.actionTypes))
        throw new WideningError(
          `scope.actionTypes "${p}" widens [${current.actionTypes.join(", ")}]`,
        );
    }
    out.actionTypes = [...next.actionTypes];
  }
  if (next.resources !== undefined) {
    if (!isStringList(next.resources)) throw new WideningError("scope.resources must be strings");
    for (const p of next.resources) {
      if (!resourcePatternCovered(p, current.resources))
        throw new WideningError(`scope.resources "${p}" widens [${current.resources.join(", ")}]`);
    }
    out.resources = [...next.resources];
  }
  return out;
}

function applyCheck(current: EffectiveAuthority, check: AttenuationCheck): EffectiveAuthority {
  if (typeof check !== "object" || check === null)
    throw new WideningError("check must be an object");
  switch (check.kind) {
    case "limit":
      return { ...current, limits: narrowLimits(current.limits, check.value) };
    case "expiry": {
      if (!isIsoDate(check.value)) throw new WideningError("expiry check must be an ISO date");
      if (new Date(check.value).getTime() > new Date(current.expiresAt).getTime())
        throw new WideningError(`expiry ${check.value} widens ${current.expiresAt}`);
      return { ...current, expiresAt: check.value };
    }
    case "scope":
      return { ...current, scope: narrowScope(current.scope, check.value) };
    default:
      throw new WideningError(`unknown check kind ${String((check as { kind: unknown }).kind)}`);
  }
}

function authorityToEffective(a: MandateAuthority): EffectiveAuthority {
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

/**
 * The intersection of the authority and every block. Throws if a block widens — call
 * {@link verifyMandateToken} first on anything untrusted.
 */
export function effectiveAuthority(token: MandateToken): EffectiveAuthority {
  let eff = authorityToEffective(token.authority);
  for (const block of token.blocks) for (const check of block.checks) eff = applyCheck(eff, check);
  return eff;
}

// ---------------------------------------------------------------------------
// Shape validation (no crypto): everything verify() needs to be able to assume.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Canonical base64 only: a lenient decoder would let two strings name one signature. */
function isCanonicalBase64(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && Buffer.from(v, "base64").toString("base64") === v;
}

function isBase64Key(v: unknown): v is string {
  return isCanonicalBase64(v) && Buffer.from(v, "base64").length === 32;
}

function shapeErrors(token: unknown): string[] {
  const errs: string[] = [];
  if (!isRecord(token)) return ["token is not an object"];
  if (token.v !== MANDATE_TOKEN_VERSION) errs.push("v must be 1");
  const a = token.authority;
  if (!isRecord(a)) errs.push("authority missing");
  else {
    for (const k of ["tenantId", "agentId", "mandateId", "grantor", "keyId"]) {
      if (typeof a[k] !== "string" || (a[k] as string).length === 0)
        errs.push(`authority.${k} missing`);
    }
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
    if (!isBase64Key(a.nextKey)) errs.push("authority.nextKey not a 32-byte key");
  }
  if (!Array.isArray(token.blocks)) errs.push("blocks must be an array");
  else {
    token.blocks.forEach((b, i) => {
      if (!isRecord(b)) return errs.push(`blocks[${i}] not an object`);
      if (!Array.isArray(b.checks)) errs.push(`blocks[${i}].checks must be an array`);
      if (!isIsoDate(b.issuedAt)) errs.push(`blocks[${i}].issuedAt not a date`);
      if (!isBase64Key(b.nextKey)) errs.push(`blocks[${i}].nextKey not a 32-byte key`);
    });
  }
  if (!Array.isArray(token.signatures) || !token.signatures.every(isCanonicalBase64))
    errs.push("signatures must be canonical base64 strings");
  else if (Array.isArray(token.blocks) && token.signatures.length !== token.blocks.length + 1)
    errs.push(`signatures: expected ${token.blocks.length + 1}, got ${token.signatures.length}`);
  // The proof is the one part of a token outside the head hash, so its shape is exact: no
  // extra keys, nothing a holder could smuggle alongside the secret or the seal.
  const p = token.proof;
  if (!isRecord(p)) errs.push("proof missing");
  else if (p.kind === "next") {
    if (!isBase64Key(p.secret)) errs.push("proof.secret not a 32-byte key");
    if (Object.keys(p).length !== 2) errs.push("proof has unexpected keys");
  } else if (p.kind === "sealed") {
    if (!isCanonicalBase64(p.signature)) errs.push("proof.signature must be canonical base64");
    if (Object.keys(p).length !== 2) errs.push("proof has unexpected keys");
  } else errs.push("proof.kind must be next | sealed");
  return errs;
}

// ---------------------------------------------------------------------------
// Verification — pure, offline.
// ---------------------------------------------------------------------------

export function verifyMandateToken(
  token: MandateToken,
  root: RootKey,
  now: Date,
  opts: VerifyOptions = {},
): VerifyResult {
  const fail = (
    code: VerifyErrorCode,
    errors: string[],
    hashes: string[] = [],
    head = "",
  ): VerifyResult => ({
    ok: false,
    code,
    errors,
    effective: null,
    blockHashes: hashes,
    headHash: head,
  });

  const shape = shapeErrors(token);
  if (shape.length > 0) return fail("malformed", shape);
  const maxBlocks = opts.maxBlocks ?? MAX_BLOCKS;
  if (token.blocks.length > maxBlocks)
    return fail("too-many-blocks", [`${token.blocks.length} blocks exceeds ${maxBlocks}`]);

  const hashes = tokenBlockHashes(token);
  const head = tokenHeadHash(token);
  const { authority } = token;

  if (opts.expect?.tenantId !== undefined && authority.tenantId !== opts.expect.tenantId)
    return fail(
      "tenant-mismatch",
      [`token tenant ${authority.tenantId} ≠ ${opts.expect.tenantId}`],
      hashes,
      head,
    );
  if (opts.expect?.agentId !== undefined && authority.agentId !== opts.expect.agentId)
    return fail(
      "agent-mismatch",
      [`token agent ${authority.agentId} ≠ ${opts.expect.agentId}`],
      hashes,
      head,
    );
  if (!(root instanceof Uint8Array) && root.keyId !== authority.keyId)
    return fail(
      "root-key-mismatch",
      [`authority.keyId ${authority.keyId} ≠ root ${root.keyId}`],
      hashes,
      head,
    );

  if (!verifyRoot(root, authorityMessage(authority), token.signatures[0]!))
    return fail(
      "root-signature",
      ["authority signature does not verify against the root key"],
      hashes,
      head,
    );

  let eff = authorityToEffective(authority);
  const seen = new Set<string>([authority.nextKey]);
  let signer = authority.nextKey;
  let prevHash = hashes[0]!;
  for (let i = 0; i < token.blocks.length; i++) {
    const block = token.blocks[i]!;
    if (!verifyEphemeral(signer, blockMessage(i, prevHash, block), token.signatures[i + 1]!))
      return fail(
        "block-signature",
        [`block ${i} signature does not verify against the key block ${i - 1} published`],
        hashes,
        head,
      );
    if (seen.has(block.nextKey))
      return fail(
        "key-reuse",
        [`block ${i} republishes an ephemeral key already used in this chain`],
        hashes,
        head,
      );
    seen.add(block.nextKey);
    try {
      for (const check of block.checks) eff = applyCheck(eff, check);
    } catch (err) {
      return fail("widening", [`block ${i}: ${(err as Error).message}`], hashes, head);
    }
    signer = block.nextKey;
    prevHash = hashes[i + 1]!;
  }

  const { proof } = token;
  if (proof.kind === "next") {
    let pub: string;
    try {
      pub = ephemeralPublicKeyOf(proof.secret);
    } catch {
      return fail("proof", ["proof.secret is not a valid key"], hashes, head);
    }
    if (pub !== signer)
      return fail(
        "proof",
        ["proof.secret does not match the head's published next key (truncated or spliced chain)"],
        hashes,
        head,
      );
  } else if (!verifyEphemeral(signer, sealMessage(head), proof.signature)) {
    return fail(
      "proof",
      ["seal signature does not verify against the head's next key"],
      hashes,
      head,
    );
  }

  if (new Date(eff.expiresAt).getTime() <= now.getTime())
    return fail("expired", [`token expired at ${eff.expiresAt}`], hashes, head);

  return { ok: true, code: null, errors: [], effective: eff, blockHashes: hashes, headHash: head };
}

// ---------------------------------------------------------------------------
// Minting, attenuation, sealing.
// ---------------------------------------------------------------------------

export type MintInput = Omit<MandateAuthority, "nextKey" | "keyId">;

/** Mint a token: the authority is signed by `keyId` through the tenant's signing provider. */
export async function mintMandateToken(
  input: MintInput,
  signer: SigningProvider,
  keyId: string,
  ephemeral: EphemeralKeyPair = generateEphemeralKey(),
): Promise<MandateToken> {
  const authority: MandateAuthority = {
    tenantId: input.tenantId,
    agentId: input.agentId,
    mandateId: input.mandateId,
    grantor: input.grantor,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    scope: { actionTypes: [...input.scope.actionTypes], resources: [...input.scope.resources] },
    limits: { ...input.limits },
    citations: [...input.citations],
    keyId,
    nextKey: ephemeral.publicKey,
  };
  const shape = shapeErrors({
    v: 1,
    authority,
    blocks: [],
    signatures: [PLACEHOLDER_SIGNATURE],
    proof: { kind: "next", secret: ephemeral.secret },
  });
  if (shape.length > 0) throw new Error(`cannot mint: ${shape.join("; ")}`);
  const signature = await signer.sign(keyId, authorityMessage(authority));
  return {
    v: MANDATE_TOKEN_VERSION,
    authority,
    blocks: [],
    signatures: [signature],
    proof: { kind: "next", secret: ephemeral.secret },
  };
}

/**
 * Append an attenuation block. Refuses to produce a widening block (the verifier would reject
 * it anyway) and a sealed token. The new token carries the NEXT ephemeral secret; the one that
 * signed this block is not retained anywhere.
 */
export function attenuateMandateToken(
  token: MandateToken,
  block: Omit<AttenuationBlock, "nextKey">,
  ephemeral: EphemeralKeyPair = generateEphemeralKey(),
): MandateToken {
  if (token.proof.kind !== "next") throw new Error("cannot attenuate a sealed token");
  // Narrowing is checked against the effective authority so far — a widening block is refused.
  let eff = effectiveAuthority(token);
  for (const check of block.checks) eff = applyCheck(eff, check);
  const full: AttenuationBlock = {
    checks: block.checks.map((c) => ({ ...c })) as AttenuationCheck[],
    issuedAt: block.issuedAt,
    nextKey: ephemeral.publicKey,
  };
  const index = token.blocks.length;
  const hashes = tokenBlockHashes(token);
  const signature = signEphemeral(token.proof.secret, blockMessage(index, hashes[index]!, full));
  return {
    v: MANDATE_TOKEN_VERSION,
    authority: token.authority,
    blocks: [...token.blocks, full],
    signatures: [...token.signatures, signature],
    proof: { kind: "next", secret: ephemeral.secret },
  };
}

/** Replace the next-key proof with a final signature: the token can no longer be attenuated. */
export function sealMandateToken(token: MandateToken): MandateToken {
  if (token.proof.kind !== "next") return token;
  const sealed: MandateToken = {
    v: MANDATE_TOKEN_VERSION,
    authority: token.authority,
    blocks: token.blocks,
    signatures: token.signatures,
    proof: { kind: "sealed", signature: "" },
  };
  const signature = signEphemeral(token.proof.secret, sealMessage(tokenHeadHash(sealed)));
  return { ...sealed, proof: { kind: "sealed", signature } };
}

/** The keyset entry shape for a raw Ed25519 root, for callers that only hold the raw key. */
export function rootEntryFromRaw(keyId: string, raw: Uint8Array): PublicKeyEntry {
  return {
    keyId,
    publicKey: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]).toString("base64"),
    algorithm: "ed25519",
  };
}
