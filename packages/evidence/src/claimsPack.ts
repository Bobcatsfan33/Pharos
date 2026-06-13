import {
  type ActionRecord,
  type PublicKeyEntry,
  type RedactedView,
  GENESIS_HASH,
  keysetVerifier,
  redactPayload,
  sha256Hex,
  verifyChain,
  verifyRedactedView,
} from "@pharos/core";
import { type TrustedTimestamp, verifyTimestamp } from "./timestamp.js";

/**
 * Claims packs v2 — one-click, audience-scoped, offline-verifiable evidence bundles.
 *
 * A pack assembles a scoped record set, a custody attestation, and a verification bundle
 * (public keysets, chain-head anchors, and the documented procedure) that a third-party
 * expert validates offline. Fields can be redacted for an audience while the pack still
 * verifies cryptographically — and the unredacted originals stay intact in WORM.
 */
export type Audience = "claims_adjuster" | "outside_counsel" | "regulator" | "broker";

export interface RecordDisclosureInput {
  record: ActionRecord;
  disclosureRoot: string;
  disclosureSignature: string;
  salts: Record<string, string>;
  commitments: Record<string, string>;
  keyId: string;
}

export interface PackRecordFull {
  kind: "full";
  sequence: number;
  record: ActionRecord;
}
export interface PackRecordRedacted {
  kind: "redacted";
  sequence: number;
  prevHash: string;
  decision: string;
  tierReached: number | string;
  redactedView: RedactedView;
}
export type PackRecord = PackRecordFull | PackRecordRedacted;

export interface ClaimsPackBundle {
  meta: {
    id: string;
    tenantId: string;
    incident: string;
    audience: Audience;
    fromSequence: number;
    toSequence: number;
    redactFields: string[];
    sealedAt: string;
    sealedBy: string;
  };
  records: PackRecord[];
  keyset: PublicKeyEntry[];
  tsaKeyset: PublicKeyEntry[];
  anchors: TrustedTimestamp[];
  custody: { sealedBy: string; sealedAt: string; bundleHash: string; procedure: string };
}

const PROCEDURE = [
  "1. For each FULL record: recompute sha256(canonical(content)) == seal.contentHash; verify seal.signature over contentHash with keyset[keyId]; check seal.prevHash links to the previous record.",
  "2. For each REDACTED record: for every shown field recompute sha256(salt|canonical(value)) == commitment; recompute the disclosureRoot from all commitments; verify the disclosure signature over sha256({disclosureRoot, contentHash}) with keyset[keyId]; check prevHash links to the previous record.",
  "3. Verify each anchor: it is signed by the TSA keyset over sha256({hash, time}); the final record's contentHash appears among the anchored hashes.",
  "4. Recompute the bundle hash over (meta, records, anchors) and confirm custody.bundleHash matches.",
].join("\n");

export function assembleClaimsPack(params: {
  id: string;
  tenantId: string;
  incident: string;
  audience: Audience;
  fromSequence: number;
  toSequence: number;
  redactFields: string[];
  records: RecordDisclosureInput[];
  keyset: PublicKeyEntry[];
  tsaKeyset: PublicKeyEntry[];
  anchors: TrustedTimestamp[];
  sealedBy: string;
  sealedAt: string;
}): ClaimsPackBundle {
  const redactMode = params.redactFields.length > 0;
  const records: PackRecord[] = params.records.map((r) => {
    if (!redactMode) {
      return { kind: "full", sequence: r.record.content.sequence, record: r.record };
    }
    const redactedView = redactPayload({
      recordId: r.record.content.id,
      contentHash: r.record.seal.contentHash,
      payload: r.record.content.action.payload,
      commitments: r.commitments,
      salts: r.salts,
      disclosureRoot: r.disclosureRoot,
      disclosureSignature: r.disclosureSignature,
      keyId: r.keyId,
      redactFields: params.redactFields,
    });
    return {
      kind: "redacted",
      sequence: r.record.content.sequence,
      prevHash: r.record.seal.prevHash,
      decision: r.record.content.verdict.decision,
      tierReached: r.record.content.verdict.tierReached,
      redactedView,
    };
  });

  const meta = {
    id: params.id,
    tenantId: params.tenantId,
    incident: params.incident,
    audience: params.audience,
    fromSequence: params.fromSequence,
    toSequence: params.toSequence,
    redactFields: params.redactFields,
    sealedAt: params.sealedAt,
    sealedBy: params.sealedBy,
  };
  const bundleHash = sha256Hex({ meta, records, anchors: params.anchors });

  return {
    meta,
    records,
    keyset: params.keyset,
    tsaKeyset: params.tsaKeyset,
    anchors: params.anchors,
    custody: { sealedBy: params.sealedBy, sealedAt: params.sealedAt, bundleHash, procedure: PROCEDURE },
  };
}

export interface ClaimsPackVerification {
  ok: boolean;
  recordsChecked: number;
  redactedRecords: number;
  anchorsVerified: number;
  errors: string[];
}

/** Verify a claims pack OFFLINE using only the bundle and its embedded public keysets. */
export function verifyClaimsPack(bundle: ClaimsPackBundle): ClaimsPackVerification {
  const out: ClaimsPackVerification = { ok: true, recordsChecked: 0, redactedRecords: 0, anchorsVerified: 0, errors: [] };
  const verify = keysetVerifier(bundle.keyset);
  const verifyTsa = keysetVerifier(bundle.tsaKeyset);

  // Bundle integrity.
  const recomputed = sha256Hex({ meta: bundle.meta, records: bundle.records, anchors: bundle.anchors });
  if (recomputed !== bundle.custody.bundleHash) out.errors.push("bundle hash mismatch");

  // Records.
  const fullRecords: ActionRecord[] = [];
  let expectedPrev: string | null = bundle.meta.fromSequence === 0 ? GENESIS_HASH : null;
  for (const entry of bundle.records) {
    out.recordsChecked += 1;
    if (entry.kind === "full") {
      const r = entry.record;
      fullRecords.push(r);
      const recomputedHash = sha256Hex(r.content);
      if (recomputedHash !== r.seal.contentHash) out.errors.push(`seq ${entry.sequence}: content hash mismatch`);
      if (!verify(r.seal.keyId, Buffer.from(r.seal.contentHash, "utf8"), r.seal.signature)) {
        out.errors.push(`seq ${entry.sequence}: signature invalid`);
      }
      if (expectedPrev !== null && r.seal.prevHash !== expectedPrev) out.errors.push(`seq ${entry.sequence}: chain link broken`);
      expectedPrev = r.seal.contentHash;
    } else {
      out.redactedRecords += 1;
      const rv = verifyRedactedView(entry.redactedView, verify);
      if (!rv.ok) out.errors.push(`seq ${entry.sequence}: redacted view invalid (${rv.errors.join("; ")})`);
      if (expectedPrev !== null && entry.prevHash !== expectedPrev) out.errors.push(`seq ${entry.sequence}: chain link broken`);
      expectedPrev = entry.redactedView.contentHash;
    }
  }

  // For an all-full pack starting at genesis, run the canonical chain verifier too.
  if (fullRecords.length === bundle.records.length && bundle.meta.fromSequence === 0) {
    const chain = verifyChain(fullRecords, bundle.keyset);
    if (!chain.ok) out.errors.push(`chain verification failed: ${chain.errors.join("; ")}`);
  }

  // Anchors: TSA-signed, and the head contentHash is anchored.
  const headHash = expectedPrev;
  let headAnchored = false;
  for (const anchor of bundle.anchors) {
    if (verifyTimestamp(anchor, verifyTsa)) {
      out.anchorsVerified += 1;
      if (anchor.hash === headHash) headAnchored = true;
    } else {
      out.errors.push(`anchor for ${anchor.hash.slice(0, 12)} has an invalid TSA signature`);
    }
  }
  if (bundle.anchors.length > 0 && !headAnchored) out.errors.push("no anchor covers the head record");

  out.ok = out.errors.length === 0;
  return out;
}
