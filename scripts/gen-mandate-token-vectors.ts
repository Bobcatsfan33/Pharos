/**
 * Generate the MandateToken conformance vectors (Workstream A).
 *
 *   pnpm exec tsx scripts/gen-mandate-token-vectors.ts
 *
 * Keys are derived from fixed seeds so the vectors are reproducible byte for byte. Every
 * vector carries the token, the root keyId, the clock, what the verifier must answer, and —
 * for valid chains — the effective authority. The core suite, the TypeScript SDK and the
 * Python SDK all consume the same file: packages/core/test/mandate-token/vectors.json.
 *
 * Test material only: the fixed private keys here must never be used anywhere else.
 */
import { writeFileSync } from "node:fs";
import { createECDH, createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import {
  attenuateMandateToken,
  blockMessage,
  ephemeralKeyFromSeed,
  mintMandateToken,
  sealMandateToken,
  tokenBlockHashes,
  verifyMandateToken,
  type AttenuationCheck,
  type EffectiveAuthority,
  type EphemeralKeyPair,
  type MandateToken,
  type PublicKeyEntry,
  type SigningProvider,
} from "../packages/core/src/index.js";

const OUT = "packages/core/test/mandate-token/vectors.json";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function seed(n: number): Buffer {
  const b = Buffer.alloc(32, 0);
  b.writeUInt32BE(0x5eed0000 + n, 28);
  return b;
}

/** PKCS#8 DER for a fixed P-256 scalar (RFC 5915 ECPrivateKey inside RFC 5208). */
function p256Pkcs8(scalar: Buffer): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(scalar);
  const point = ecdh.getPublicKey(); // 65-byte uncompressed
  const ecPrivateKey = Buffer.concat([
    Buffer.from("020101", "hex"),
    Buffer.from("0420", "hex"),
    scalar,
    Buffer.from("a144034200", "hex"),
    point,
  ]);
  const inner = Buffer.concat([Buffer.from([0x30, ecPrivateKey.length]), ecPrivateKey]);
  const algId = Buffer.from("301306072a8648ce3d020106082a8648ce3d030107", "hex");
  const body = Buffer.concat([
    Buffer.from("020100", "hex"),
    algId,
    Buffer.from([0x04, inner.length]),
    inner,
  ]);
  return Buffer.concat([Buffer.from([0x30, 0x81, body.length]), body]);
}

/** A fixed-key signer standing in for the tenant KMS: Ed25519 roots and an ECDSA P-256 root. */
function fixedSigner(): { signer: SigningProvider; keyset: PublicKeyEntry[] } {
  const edKey = (n: number) =>
    createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed(n)]),
      format: "der",
      type: "pkcs8",
    });
  const keys: Record<
    string,
    { key: ReturnType<typeof createPrivateKey>; algorithm: "ed25519" | "ecdsa-p256" }
  > = {
    "mandate:acme#v1": { key: edKey(1), algorithm: "ed25519" },
    "mandate:other#v1": { key: edKey(2), algorithm: "ed25519" },
    "mandate:acme-ecdsa#v1": {
      key: createPrivateKey({ key: p256Pkcs8(seed(3)), format: "der", type: "pkcs8" }),
      algorithm: "ecdsa-p256",
    },
  };
  const entry = (keyId: string): PublicKeyEntry => ({
    keyId,
    publicKey: createPublicKey(keys[keyId]!.key)
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    algorithm: keys[keyId]!.algorithm,
  });
  const signer: SigningProvider = {
    providerId: "fixed",
    ensureKey: async (name) => `${name}#v1`,
    rotate: async (name) => `${name}#v1`,
    activeKeyId: async (name) => `${name}#v1`,
    sign: async (keyId, message) => {
      const k = keys[keyId]!;
      return nodeSign(k.algorithm === "ecdsa-p256" ? "sha256" : null, message, k.key).toString(
        "base64",
      );
    },
    verify: async () => {
      throw new Error("not used");
    },
    getPublicKey: async (keyId) => (keys[keyId] ? entry(keyId) : null),
    publishKeyset: async () => Object.keys(keys).map(entry),
  };
  return { signer, keyset: Object.keys(keys).map(entry) };
}

function signWithSecret(secret: string, message: Buffer): string {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secret, "base64")]),
    format: "der",
    type: "pkcs8",
  });
  return nodeSign(null, message, key).toString("base64");
}

/** Sign a widening block properly (bypassing attenuate's refusal) so only the widening is wrong. */
function craftWideningBlock(
  token: MandateToken,
  ephemeral: EphemeralKeyPair,
  checks: AttenuationCheck[],
): MandateToken {
  if (token.proof.kind !== "next") throw new Error("need an open token");
  const block = { checks, issuedAt: "2026-10-30T01:00:00.000Z", nextKey: ephemeral.publicKey };
  const sig = signWithSecret(
    token.proof.secret,
    blockMessage(0, tokenBlockHashes(token)[0]!, block),
  );
  return {
    ...token,
    blocks: [block],
    signatures: [...token.signatures, sig],
    proof: { kind: "next", secret: ephemeral.secret },
  };
}

/** Block 0 republishes the authority's key; block 1 is signed with it again. */
function craftKeyReuse(
  token: MandateToken,
  reused: EphemeralKeyPair,
  next: EphemeralKeyPair,
): MandateToken {
  const b0 = {
    checks: [{ kind: "limit" as const, value: { financialAmount: 100 } }],
    issuedAt: "2026-10-30T01:00:00.000Z",
    nextKey: reused.publicKey,
  };
  const h = tokenBlockHashes(token);
  const s0 = signWithSecret(reused.secret, blockMessage(0, h[0]!, b0));
  const t1: MandateToken = {
    ...token,
    blocks: [b0],
    signatures: [...token.signatures, s0],
    proof: { kind: "next", secret: reused.secret },
  };
  const b1 = {
    checks: [{ kind: "limit" as const, value: { financialAmount: 50 } }],
    issuedAt: "2026-10-30T02:00:00.000Z",
    nextKey: next.publicKey,
  };
  const s1 = signWithSecret(reused.secret, blockMessage(1, tokenBlockHashes(t1)[1]!, b1));
  return {
    ...t1,
    blocks: [b0, b1],
    signatures: [...t1.signatures, s1],
    proof: { kind: "next", secret: next.secret },
  };
}

interface Vector {
  name: string;
  description: string;
  rootKeyId: string;
  now: string;
  expect: { tenantId?: string; agentId?: string };
  token: MandateToken;
  result: { ok: boolean; code: string | null; effective: EffectiveAuthority | null };
}

async function main(): Promise<void> {
  const { signer, keyset } = fixedSigner();
  const now = "2026-10-30T12:00:00.000Z";
  const base = {
    tenantId: "acme",
    agentId: "treasury-agent",
    mandateId: "vendor-payments",
    grantor: "cfo",
    issuedAt: "2026-10-30T00:00:00.000Z",
    expiresAt: "2036-11-30T00:00:00.000Z",
    scope: { actionTypes: ["payment.", "invoice.read"], resources: ["acct:*"] },
    limits: { financialAmount: 25000, currency: "USD", reversibility: "any" as const },
    citations: ["finra-2210-promissory", "treasury-policy-7"],
  };
  const k = (n: number) => ephemeralKeyFromSeed(seed(100 + n));

  const root = await mintMandateToken(base, signer, "mandate:acme#v1", k(0));
  const b1 = attenuateMandateToken(
    root,
    {
      checks: [
        { kind: "limit", value: { financialAmount: 5000 } },
        { kind: "scope", value: { actionTypes: ["payment.transfer"] } },
      ],
      issuedAt: "2026-10-30T01:00:00.000Z",
    },
    k(1),
  );
  const b2 = attenuateMandateToken(
    b1,
    {
      checks: [
        { kind: "expiry", value: "2035-11-01T00:00:00.000Z" },
        { kind: "scope", value: { resources: ["acct:ops-*"] } },
        { kind: "limit", value: { reversibility: "reversible" } },
      ],
      issuedAt: "2026-10-30T02:00:00.000Z",
    },
    k(2),
  );

  const vectors: Vector[] = [];
  const push = (
    name: string,
    description: string,
    token: MandateToken,
    rootKeyId = "mandate:acme#v1",
    expect: Vector["expect"] = { tenantId: "acme", agentId: "treasury-agent" },
    at = now,
  ) => {
    const entry = keyset.find((e) => e.keyId === rootKeyId)!;
    const r = verifyMandateToken(token, entry, new Date(at), { expect });
    vectors.push({
      name,
      description,
      rootKeyId,
      now: at,
      expect,
      token,
      result: { ok: r.ok, code: r.code, effective: r.effective },
    });
  };

  push("authority-only", "A freshly minted token with no attenuation.", root);
  push("valid-chain", "Authority + two narrowing blocks, next-key proof.", b2);
  push(
    "valid-sealed",
    "The same chain sealed: no further attenuation possible.",
    sealMandateToken(b2),
  );
  push("truncated-chain", "Last block removed; the proof no longer matches the head's next key.", {
    ...b2,
    blocks: b2.blocks.slice(0, 1),
    signatures: b2.signatures.slice(0, 2),
  });
  push(
    "widened-scope",
    "A correctly signed block whose scope check names an action type the authority never granted.",
    craftWideningBlock(root, k(1), [
      { kind: "scope", value: { actionTypes: ["payment.transfer", "wire.send"] } },
    ]),
  );
  push(
    "widened-limit",
    "A correctly signed block that raises the monetary ceiling.",
    craftWideningBlock(root, k(1), [{ kind: "limit", value: { financialAmount: 30000 } }]),
  );
  push(
    "widened-expiry",
    "A correctly signed block that extends the expiry.",
    craftWideningBlock(root, k(1), [{ kind: "expiry", value: "2037-12-31T00:00:00.000Z" }]),
  );
  push(
    "expired",
    "Valid chain evaluated after its (attenuated) expiry.",
    b2,
    undefined,
    undefined,
    "2036-01-01T00:00:00.000Z",
  );
  push(
    "wrong-root",
    "The authority names another tenant's mandate key, which never signed it.",
    { ...b2, authority: { ...b2.authority, keyId: "mandate:other#v1" } },
    "mandate:other#v1",
  );
  push(
    "root-key-mismatch",
    "The authority names a key other than the one presented.",
    b2,
    "mandate:other#v1",
  );
  push(
    "replayed-ephemeral-key",
    "Block 0 republishes the authority's ephemeral key; every signature verifies, the reuse is refused.",
    craftKeyReuse(root, k(0), k(1)),
  );
  {
    const tampered: MandateToken = JSON.parse(JSON.stringify(b2));
    (
      tampered.blocks[0]!.checks[0] as { value: { financialAmount: number } }
    ).value.financialAmount = 24000;
    push("tampered-block", "A block edited after signing.", tampered);
  }
  push("reordered-blocks", "Blocks swapped: signatures are bound to position.", {
    ...b2,
    blocks: [b2.blocks[1]!, b2.blocks[0]!],
    signatures: [b2.signatures[0]!, b2.signatures[2]!, b2.signatures[1]!],
  });
  push("tenant-mismatch", "A valid token presented for a different tenant.", b2, undefined, {
    tenantId: "globex",
  });
  push("agent-mismatch", "A valid token presented by a different agent.", b2, undefined, {
    tenantId: "acme",
    agentId: "other-agent",
  });
  push("malformed-signatures", "Signature count does not match block count.", {
    ...b2,
    signatures: b2.signatures.slice(0, 2),
  });
  {
    const tampered: MandateToken = JSON.parse(JSON.stringify(root));
    tampered.authority.limits.financialAmount = 1_000_000;
    push("tampered-authority", "Authority edited after the root signed it.", tampered);
  }
  {
    const ec = await mintMandateToken(
      { ...base, tenantId: "acme-ecdsa" },
      signer,
      "mandate:acme-ecdsa#v1",
      k(5),
    );
    const ec1 = attenuateMandateToken(
      ec,
      {
        checks: [{ kind: "limit", value: { financialAmount: 100 } }],
        issuedAt: "2026-10-30T01:00:00.000Z",
      },
      k(6),
    );
    push(
      "ecdsa-root",
      "Root signed by an ECDSA P-256 (AWS KMS style) mandate key.",
      ec1,
      "mandate:acme-ecdsa#v1",
      {
        tenantId: "acme-ecdsa",
        agentId: "treasury-agent",
      },
    );
  }

  writeFileSync(
    OUT,
    `${JSON.stringify({ generatedBy: "scripts/gen-mandate-token-vectors.ts", keyset, vectors }, null, 2)}\n`,
  );
  console.log(`wrote ${vectors.length} vectors to ${OUT}`);
  for (const v of vectors)
    console.log(`  ${v.name.padEnd(24)} ok=${v.result.ok} code=${v.result.code}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
