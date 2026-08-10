import { type ActionRecord, ActionRecordSchema, GENESIS_HASH } from "../schema/actionRecord.js";
import { sealAlgorithmIsAuthoritative } from "../schema/version.js";
import { type PublicKeyEntry, sealSigningMessage } from "../signing/provider.js";
import { sha256Hex } from "./canonical.js";
import { verify as nodeVerify, createPublicKey } from "node:crypto";

/**
 * Verify one signature against a published key entry, dispatching on its algorithm.
 * Both keys are SPKI DER; the only difference is the node:crypto verify parameters:
 * Ed25519 signs the message directly (algorithm `null`), ECDSA P-256 signs its SHA-256
 * digest (algorithm `"sha256"`, DER-encoded signature — the AWS KMS output format).
 */
export function verifyWithKeyEntry(
  entry: PublicKeyEntry,
  message: Buffer,
  signature: string,
): boolean {
  const publicKey = createPublicKey({
    key: Buffer.from(entry.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  const sig = Buffer.from(signature, "base64");
  if (entry.algorithm === "ecdsa-p256") {
    return nodeVerify("sha256", message, publicKey, sig);
  }
  return nodeVerify(null, message, publicKey, sig);
}

export interface RecordVerification {
  ok: boolean;
  recordId: string;
  sequence: number;
  checks: {
    schemaValid: boolean;
    contentHashMatches: boolean;
    signatureValid: boolean;
    chainLinkValid: boolean;
    /**
     * Does `seal.algorithm` agree with the keyset entry that verified the signature?
     *
     * Enforced only for `schemaVersion >= 1.1.0` (ADR 0005 / #67); `true` for older
     * records, where the field is informational and legacy aws-kms seals are known to
     * misstate it. This is a CONSISTENCY check reported alongside the others — it is
     * never an input to signature verification, which always dispatches on the keyset.
     */
    sealAlgorithmMatches: boolean;
  };
  errors: string[];
}

export interface ChainVerification {
  ok: boolean;
  tenantId: string | null;
  recordsChecked: number;
  firstBrokenSequence: number | null;
  records: RecordVerification[];
  errors: string[];
}

/** Verify a single record's content hash and signature against a public keyset. */
function verifySignatureWithKeyset(
  message: Buffer,
  signature: string,
  keyId: string,
  keyset: Map<string, PublicKeyEntry>,
): { ok: boolean; error?: string } {
  const entry = keyset.get(keyId);
  if (!entry) return { ok: false, error: `unknown keyId ${keyId}` };
  try {
    const ok = verifyWithKeyEntry(entry, message, signature);
    return { ok, error: ok ? undefined : "signature mismatch" };
  } catch (err) {
    return { ok: false, error: `signature verification error: ${(err as Error).message}` };
  }
}

/**
 * Build an offline signature checker from a published keyset (Ed25519 or ECDSA P-256, per
 * each entry's algorithm). This is the pure verification primitive a third party uses (for
 * chain signatures, disclosure bindings, and trusted-timestamp anchors) without any Pharos
 * infrastructure.
 */
export function keysetVerifier(
  keyset: PublicKeyEntry[] | Map<string, PublicKeyEntry>,
): (keyId: string, message: Buffer, signature: string) => boolean {
  const map = keyset instanceof Map ? keyset : new Map(keyset.map((k) => [k.keyId, k]));
  return (keyId, message, signature) => {
    const entry = map.get(keyId);
    if (!entry) return false;
    try {
      return verifyWithKeyEntry(entry, message, signature);
    } catch {
      return false;
    }
  };
}

export function verifyRecord(
  record: ActionRecord,
  prevHash: string,
  keyset: Map<string, PublicKeyEntry>,
): RecordVerification {
  const errors: string[] = [];
  const parsed = ActionRecordSchema.safeParse(record);
  const schemaValid = parsed.success;
  if (!schemaValid)
    errors.push(`schema invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

  const recomputed = sha256Hex(record.content);
  const contentHashMatches = recomputed === record.seal.contentHash;
  if (!contentHashMatches)
    errors.push(
      `content hash mismatch: recomputed ${recomputed} != sealed ${record.seal.contentHash}`,
    );

  // Dispatch on seal.sigVersion: v2 signatures bind {sequence, prevHash,
  // contentHash}; legacy v1 covered contentHash only.
  const sig = verifySignatureWithKeyset(
    sealSigningMessage(record.seal, record.content.sequence),
    record.seal.signature,
    record.seal.keyId,
    keyset,
  );
  if (!sig.ok) errors.push(`signature invalid: ${sig.error}`);

  const chainLinkValid = record.seal.prevHash === prevHash;
  if (!chainLinkValid)
    errors.push(`chain link broken: prevHash ${record.seal.prevHash} != expected ${prevHash}`);

  // Consistency, NOT dispatch (ADR 0005 / #67). The signature was verified above against
  // the keyset entry's algorithm; this asks the separate question of whether the record
  // describes itself truthfully. Enforced from schema 1.1.0 onward — v1.0.0 records are
  // known to misstate this for aws-kms seals and are never rewritten, so checking them
  // would fail honest historical evidence.
  //
  // The gating `schemaVersion` is inside `content`, hence hashed and signed: a v1.1
  // record cannot be downgraded to escape this check without breaking its signature.
  const entry = keyset.get(record.seal.keyId);
  let sealAlgorithmMatches = true;
  if (sealAlgorithmIsAuthoritative(record.content.schemaVersion) && entry) {
    sealAlgorithmMatches = record.seal.algorithm === entry.algorithm;
    if (!sealAlgorithmMatches) {
      errors.push(
        `seal algorithm mismatch: record claims ${record.seal.algorithm} but key ` +
          `${record.seal.keyId} is ${entry.algorithm}`,
      );
    }
  }

  return {
    ok: schemaValid && contentHashMatches && sig.ok && chainLinkValid && sealAlgorithmMatches,
    recordId: record.content.id,
    sequence: record.content.sequence,
    checks: {
      schemaValid,
      contentHashMatches,
      signatureValid: sig.ok,
      chainLinkValid,
      sealAlgorithmMatches,
    },
    errors,
  };
}

/**
 * Verify a full per-tenant chain from genesis to head.
 *
 * `records` must be ordered by ascending sequence. This is the routine an external
 * verifier runs offline given only the records and the published keyset — no Pharos
 * infrastructure required.
 */
export function verifyChain(
  records: ActionRecord[],
  keyset: PublicKeyEntry[] | Map<string, PublicKeyEntry>,
): ChainVerification {
  const keyMap = keyset instanceof Map ? keyset : new Map(keyset.map((k) => [k.keyId, k]));
  const out: ChainVerification = {
    ok: true,
    tenantId: records[0]?.content.tenantId ?? null,
    recordsChecked: 0,
    firstBrokenSequence: null,
    records: [],
    errors: [],
  };

  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 0;
  for (const record of records) {
    if (record.content.sequence !== expectedSeq) {
      out.ok = false;
      out.errors.push(`sequence gap: expected ${expectedSeq}, got ${record.content.sequence}`);
      out.firstBrokenSequence ??= record.content.sequence;
    }
    if (out.tenantId && record.content.tenantId !== out.tenantId) {
      out.ok = false;
      out.errors.push(`tenant mismatch at sequence ${record.content.sequence}`);
      out.firstBrokenSequence ??= record.content.sequence;
    }
    const rv = verifyRecord(record, expectedPrev, keyMap);
    out.records.push(rv);
    out.recordsChecked += 1;
    if (!rv.ok) {
      out.ok = false;
      out.firstBrokenSequence ??= record.content.sequence;
      // Preserve the detailed record-level diagnosis in the chain summary. Operators and
      // offline verifiers commonly consume only `ChainVerification.errors`; returning an
      // empty array while `ok === false` makes the most important failure path unactionable.
      // Prefix every detail with its sequence so repeated hashes/key ids remain attributable.
      out.errors.push(...rv.errors.map((error) => `sequence ${record.content.sequence}: ${error}`));
    }
    expectedPrev = record.seal.contentHash;
    expectedSeq = record.content.sequence + 1;
  }
  return out;
}
