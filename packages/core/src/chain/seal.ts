import {
  type ActionRecord,
  type ActionRecordContent,
  ActionRecordContentSchema,
  type RecordSeal,
} from "../schema/actionRecord.js";
import {
  SEAL_SIGNATURE_VERSION,
  type SigningProvider,
  signingMessageV2,
} from "../signing/provider.js";
import { sha256Hex } from "./canonical.js";

/**
 * Seal a record: hash its content, link it to the prior record, and sign it.
 *
 * The content is validated against the frozen schema before hashing so we never
 * seal a malformed record. The signature is over the contentHash, and the keyId is
 * embedded — giving the record everything an external party needs to verify it.
 */
export async function sealRecord(params: {
  content: ActionRecordContent;
  prevHash: string;
  signer: SigningProvider;
  keyId: string;
}): Promise<ActionRecord> {
  const content = ActionRecordContentSchema.parse(params.content);
  const contentHash = sha256Hex(content);
  const signature = await params.signer.sign(
    params.keyId,
    signingMessageV2({ contentHash, prevHash: params.prevHash, sequence: content.sequence }),
  );

  // The algorithm is read from the signing key, never hardcoded (ADR 0005 / #67).
  // Hardcoding "ed25519" is what made every aws-kms record misstate itself. If the key
  // cannot be resolved we refuse to seal rather than guess: a record that misdescribes
  // its own signature is exactly the defect being removed.
  const entry = await params.signer.getPublicKey(params.keyId);
  if (!entry) {
    throw new Error(
      `cannot seal record: signing key ${params.keyId} has no published public key entry, ` +
        `so its signature algorithm cannot be stated truthfully`,
    );
  }

  const seal: RecordSeal = {
    contentHash,
    prevHash: params.prevHash,
    algorithm: entry.algorithm,
    keyId: params.keyId,
    signature,
    sigVersion: SEAL_SIGNATURE_VERSION,
  };
  return { content, seal };
}
