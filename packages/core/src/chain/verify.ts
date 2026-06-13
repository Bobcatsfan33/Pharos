import {
  type ActionRecord,
  ActionRecordSchema,
  GENESIS_HASH,
} from "../schema/actionRecord.js";
import { type PublicKeyEntry, signingMessage } from "../signing/provider.js";
import { sha256Hex } from "./canonical.js";
import { verify as edVerify, createPublicKey } from "node:crypto";

export interface RecordVerification {
  ok: boolean;
  recordId: string;
  sequence: number;
  checks: {
    schemaValid: boolean;
    contentHashMatches: boolean;
    signatureValid: boolean;
    chainLinkValid: boolean;
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
  contentHash: string,
  signature: string,
  keyId: string,
  keyset: Map<string, PublicKeyEntry>,
): { ok: boolean; error?: string } {
  const entry = keyset.get(keyId);
  if (!entry) return { ok: false, error: `unknown keyId ${keyId}` };
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(entry.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    const ok = edVerify(null, signingMessage(contentHash), publicKey, Buffer.from(signature, "base64"));
    return { ok, error: ok ? undefined : "signature mismatch" };
  } catch (err) {
    return { ok: false, error: `signature verification error: ${(err as Error).message}` };
  }
}

export function verifyRecord(
  record: ActionRecord,
  prevHash: string,
  keyset: Map<string, PublicKeyEntry>,
): RecordVerification {
  const errors: string[] = [];
  const parsed = ActionRecordSchema.safeParse(record);
  const schemaValid = parsed.success;
  if (!schemaValid) errors.push(`schema invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

  const recomputed = sha256Hex(record.content);
  const contentHashMatches = recomputed === record.seal.contentHash;
  if (!contentHashMatches) errors.push(`content hash mismatch: recomputed ${recomputed} != sealed ${record.seal.contentHash}`);

  const sig = verifySignatureWithKeyset(record.seal.contentHash, record.seal.signature, record.seal.keyId, keyset);
  if (!sig.ok) errors.push(`signature invalid: ${sig.error}`);

  const chainLinkValid = record.seal.prevHash === prevHash;
  if (!chainLinkValid) errors.push(`chain link broken: prevHash ${record.seal.prevHash} != expected ${prevHash}`);

  return {
    ok: schemaValid && contentHashMatches && sig.ok && chainLinkValid,
    recordId: record.content.id,
    sequence: record.content.sequence,
    checks: { schemaValid, contentHashMatches, signatureValid: sig.ok, chainLinkValid },
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
  const keyMap =
    keyset instanceof Map ? keyset : new Map(keyset.map((k) => [k.keyId, k]));
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
    }
    const rv = verifyRecord(record, expectedPrev, keyMap);
    out.records.push(rv);
    out.recordsChecked += 1;
    if (!rv.ok) {
      out.ok = false;
      out.firstBrokenSequence ??= record.content.sequence;
    }
    expectedPrev = record.seal.contentHash;
    expectedSeq = record.content.sequence + 1;
  }
  return out;
}
