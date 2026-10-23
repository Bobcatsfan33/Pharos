import {
  verifyChain,
  keysetVerifier,
  type ActionRecord,
  type ChainVerification,
  type PublicKeyEntry,
} from "@pharos/core";
import { verifyTimestamp, type TrustedTimestamp } from "./timestamp.js";

/**
 * The portable evidence bundle: everything a third party needs to verify a chain with no
 * Pharos infrastructure. Written by `pharos export` and the demo; read by `pharos verify`,
 * `scripts/external-verify.ts`, and the browser verifier. Public keys only — never secrets.
 */
export interface EvidenceBundle {
  tenantId?: string;
  records: ActionRecord[];
  keyset?: PublicKeyEntry[];
  /** Accepted alias for `keyset`. */
  keys?: PublicKeyEntry[];
  /** Trusted-time anchors over chain heads (local-signed or RFC 3161 tokens). */
  anchors?: TrustedTimestamp[];
  /** Published TSA public keys (for `local` anchors; rfc3161 tokens self-verify). */
  tsaKeyset?: PublicKeyEntry[];
}

export interface AnchorVerification {
  anchor: TrustedTimestamp;
  kind: "local" | "rfc3161";
  ok: boolean;
  coversHead: boolean;
}

export interface BundleVerification {
  tenantId: string;
  chain: ChainVerification;
  anchors: AnchorVerification[];
  /** True when no anchors are present (anchors are optional) or every anchor verifies and one covers the head. */
  anchorsOk: boolean;
  /** `chain.ok && anchorsOk` — the one bit a caller should act on. */
  ok: boolean;
  errors: string[];
}

export interface BundleTrustPolicy {
  /** Approved RFC 3161 leaf-certificate SHA-256 fingerprints; required if any rfc3161 anchor is present. */
  trustedCertSha256?: string[];
}

/** Parse and shape-check a bundle (records + keyset required; anchors optional). Throws on a malformed bundle. */
export function readEvidenceBundle(raw: unknown): Required<Pick<EvidenceBundle, "records">> & {
  tenantId: string;
  keys: PublicKeyEntry[];
  anchors: TrustedTimestamp[];
  tsaKeys: PublicKeyEntry[];
} {
  const bundle = raw as EvidenceBundle;
  const keys = bundle?.keyset ?? bundle?.keys;
  if (!bundle || !Array.isArray(bundle.records) || bundle.records.length === 0) {
    throw new Error("bundle must contain a non-empty records array");
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("bundle must contain a non-empty keyset or keys array");
  }
  return {
    tenantId: bundle.tenantId ?? bundle.records[0]!.content.tenantId,
    records: bundle.records,
    keys,
    anchors: bundle.anchors ?? [],
    tsaKeys: bundle.tsaKeyset ?? [],
  };
}

/**
 * Verify a bundle entirely offline: every hash, signature and chain link against the
 * published keyset, then every trusted-time anchor (local anchors against the TSA keyset,
 * RFC 3161 tokens against their embedded certificate and the caller's pins). Pure: no I/O.
 */
export function verifyEvidenceBundle(
  raw: unknown,
  trust: BundleTrustPolicy = {},
): BundleVerification {
  const bundle = readEvidenceBundle(raw);
  const chain = verifyChain(bundle.records, bundle.keys);
  const errors = [...chain.errors];
  const pins = trust.trustedCertSha256 ?? [];

  const anchors: AnchorVerification[] = [];
  let anchorsOk = true;
  if (bundle.anchors.length > 0) {
    if (bundle.anchors.some((a) => a.provider === "rfc3161") && pins.length === 0) {
      throw new Error(
        "RFC 3161 verification requires trustedCertSha256 pins from an independent approved source",
      );
    }
    const headHash = bundle.records[bundle.records.length - 1]!.seal.contentHash;
    const verifyTsa = keysetVerifier(bundle.tsaKeys);
    let headAnchored = false;
    for (const anchor of bundle.anchors) {
      const ok = verifyTimestamp(anchor, verifyTsa, { trustedCertSha256: pins });
      const coversHead = anchor.hash === headHash;
      anchors.push({ anchor, kind: anchor.provider ?? "local", ok, coversHead });
      if (!ok) {
        anchorsOk = false;
        errors.push(
          `anchor over ${anchor.hash.slice(0, 12)}… at ${anchor.time} failed verification`,
        );
      }
      if (ok && coversHead) headAnchored = true;
    }
    if (!headAnchored) {
      anchorsOk = false;
      errors.push("no valid anchor covers the head record");
    }
  }
  return {
    tenantId: bundle.tenantId,
    chain,
    anchors,
    anchorsOk,
    ok: chain.ok && anchorsOk,
    errors,
  };
}
