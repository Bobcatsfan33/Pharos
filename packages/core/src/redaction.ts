import { randomBytes } from "node:crypto";
import { canonicalize, sha256Hex } from "./chain/canonical.js";

/**
 * Selective-disclosure redaction commitments.
 *
 * To redact payload fields for a given audience while preserving cryptographic
 * verifiability, every record commits to its payload fields at seal time:
 *
 *   commitment[field] = sha256( salt[field] || canonical(value) )
 *   disclosureRoot    = sha256( canonical(sorted commitments) )    -- signed by the KMS key
 *
 * This is ADDITIVE — it does not change the record's contentHash or chain, so existing
 * verification is untouched and the unredacted original stays intact. A redacted view
 * reveals (salt, value) for shown fields and only the commitment for redacted fields; a
 * verifier recomputes each shown field's commitment, recomputes the disclosureRoot, and
 * checks the signature. The redacted fields are proven to have existed (committed) without
 * being revealed. (SD-JWT / verifiable-credentials style selective disclosure.)
 */
export interface DisclosureSet {
  commitments: Record<string, string>;
  salts: Record<string, string>;
  disclosureRoot: string;
}

export function computeDisclosures(payload: Record<string, unknown>): DisclosureSet {
  const commitments: Record<string, string> = {};
  const salts: Record<string, string> = {};
  for (const [field, value] of Object.entries(payload)) {
    const salt = randomBytes(16).toString("hex");
    salts[field] = salt;
    commitments[field] = sha256Hex(`${salt}|${canonicalize(value)}`);
  }
  return { commitments, salts, disclosureRoot: disclosureRoot(commitments) };
}

export function disclosureRoot(commitments: Record<string, string>): string {
  const sorted = Object.keys(commitments)
    .sort()
    .map((k) => [k, commitments[k]]);
  return sha256Hex(sorted);
}

/**
 * The message the KMS signs for a record's disclosures, binding the disclosure root to the
 * record's contentHash so a redacted view cannot be lifted onto a different record.
 */
export function disclosureBindingMessage(root: string, contentHash: string): Buffer {
  return Buffer.from(sha256Hex({ disclosureRoot: root, contentHash }), "utf8");
}

export interface RedactedField {
  /** The revealed value (present only when not redacted). */
  value?: unknown;
  /** The salt for the revealed value (present only when not redacted). */
  salt?: string;
  commitment: string;
  redacted: boolean;
}

export interface RedactedView {
  recordId: string;
  contentHash: string;
  fields: Record<string, RedactedField>;
  disclosureRoot: string;
  disclosureSignature: string;
  keyId: string;
}

/** Build a redacted view of a payload for an audience, hiding `redactFields`. */
export function redactPayload(params: {
  recordId: string;
  contentHash: string;
  payload: Record<string, unknown>;
  commitments: Record<string, string>;
  salts: Record<string, string>;
  disclosureRoot: string;
  disclosureSignature: string;
  keyId: string;
  redactFields: string[];
}): RedactedView {
  const redactSet = new Set(params.redactFields);
  const fields: Record<string, RedactedField> = {};
  for (const field of Object.keys(params.commitments)) {
    const commitment = params.commitments[field]!;
    if (redactSet.has(field)) {
      fields[field] = { commitment, redacted: true };
    } else {
      fields[field] = {
        value: params.payload[field],
        salt: params.salts[field],
        commitment,
        redacted: false,
      };
    }
  }
  return {
    recordId: params.recordId,
    contentHash: params.contentHash,
    fields,
    disclosureRoot: params.disclosureRoot,
    disclosureSignature: params.disclosureSignature,
    keyId: params.keyId,
  };
}

export interface RedactionVerification {
  ok: boolean;
  errors: string[];
  revealedFields: string[];
  redactedFields: string[];
}

/**
 * Verify a redacted view: every shown field's commitment recomputes from (salt, value);
 * the disclosureRoot recomputes from all commitments; and the signature over the root is
 * valid for keyId. Pure — no infrastructure needed. `verifySignature` is injected so this
 * stays dependency-free (the chain verifier supplies the Ed25519 check).
 */
export function verifyRedactedView(
  view: RedactedView,
  verifySignature: (keyId: string, message: Buffer, signature: string) => boolean,
): RedactionVerification {
  const errors: string[] = [];
  const revealed: string[] = [];
  const redacted: string[] = [];
  const commitments: Record<string, string> = {};

  for (const [field, f] of Object.entries(view.fields)) {
    commitments[field] = f.commitment;
    if (f.redacted) {
      redacted.push(field);
      continue;
    }
    revealed.push(field);
    if (f.salt === undefined) {
      errors.push(`field ${field} revealed without a salt`);
      continue;
    }
    const recomputed = sha256Hex(`${f.salt}|${canonicalize(f.value)}`);
    if (recomputed !== f.commitment) errors.push(`field ${field} commitment mismatch`);
  }

  const root = disclosureRoot(commitments);
  if (root !== view.disclosureRoot) errors.push("disclosure root mismatch");

  const message = disclosureBindingMessage(view.disclosureRoot, view.contentHash);
  const sigOk = verifySignature(view.keyId, message, view.disclosureSignature);
  if (!sigOk) errors.push("disclosure signature invalid");

  return { ok: errors.length === 0, errors, revealedFields: revealed, redactedFields: redacted };
}
