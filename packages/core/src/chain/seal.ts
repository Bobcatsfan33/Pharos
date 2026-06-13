import {
  type ActionRecord,
  type ActionRecordContent,
  ActionRecordContentSchema,
  type RecordSeal,
} from "../schema/actionRecord.js";
import { type SigningProvider, signingMessage } from "../signing/provider.js";
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
  const signature = await params.signer.sign(params.keyId, signingMessage(contentHash));
  const seal: RecordSeal = {
    contentHash,
    prevHash: params.prevHash,
    algorithm: "ed25519",
    keyId: params.keyId,
    signature,
  };
  return { content, seal };
}
