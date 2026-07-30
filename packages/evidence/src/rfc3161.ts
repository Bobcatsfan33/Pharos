import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import {
  createHash,
  createVerify,
  X509Certificate,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * RFC 3161 trusted-timestamp client and offline verifier.
 *
 * We build the TimeStampReq and parse the TimeStampResp/TimeStampToken with pkijs/asn1js
 * (no hand-rolled ASN.1), but verify the token's CMS signature with node:crypto: the token
 * carries the TSA's signing certificate, so verification is fully offline and needs no Pharos
 * infrastructure. Three checks establish trusted time for a hash:
 *   1. the token's messageImprint equals SHA-256 of the anchored value (the token is FOR us), and
 *   2. the token's CMS signature verifies against its embedded TSA certificate (the time is the
 *      TSA's, not ours) — over the signed attributes, whose messageDigest binds the TSTInfo, and
 *   3. in production, that signing certificate's SHA-256 fingerprint matches an independently
 *      configured enterprise-approved pin (the signer is the CONTRACTED TSA, not merely any TSA).
 */
const OID = {
  SHA256: "2.16.840.1.101.3.4.2.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  idCtTSTInfo: "1.2.840.113549.1.9.16.1.4",
  timeStampingEku: "1.3.6.1.5.5.7.3.8",
} as const;

// signerInfo digest algorithm OID → node:crypto hash name.
const DIGEST_ALGO: Record<string, string> = {
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/** DER-encode a TimeStampReq that requests a token over SHA-256(anchoredValue), with certReq. */
export function buildTimeStampRequest(anchoredValue: string): Buffer {
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.SHA256 }),
      hashedMessage: new asn1js.OctetString({
        valueHex: sha256(Buffer.from(anchoredValue, "utf8")),
      }),
    }),
    certReq: true, // ask the TSA to embed its cert so the token is self-verifiable
    nonce: new asn1js.Integer({ valueHex: randomBytes(16) }),
  });
  return Buffer.from(req.toSchema().toBER(false));
}

export interface TimestampResult {
  /** The full DER TimeStampToken (CMS SignedData), base64. Stored verbatim in the anchor. */
  tokenBase64: string;
  /** The TSA's asserted time (TSTInfo genTime), RFC-3339. */
  genTime: string;
}

export interface Rfc3161Options {
  /** Fetch timeout (ms). */
  timeoutMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Trust policy applied to every received token before it is persisted. */
  trustPolicy?: Rfc3161TrustPolicy;
}

export interface Rfc3161TrustPolicy {
  /**
   * Approved TSA leaf-certificate SHA-256 fingerprints, without separators.
   * Configure at least two during planned certificate rotation.
   */
  trustedCertSha256?: readonly string[];
  /**
   * Backward-compatible direct root check. Certificate pins are preferred because they remain
   * deterministic offline and do not imply support for arbitrary intermediate chains.
   */
  trustedRootsPem?: readonly string[];
}

/** POST a TimeStampReq to a TSA and return the (verified) token + its asserted time. */
export async function requestTimestamp(
  url: string,
  anchoredValue: string,
  opts: Rfc3161Options = {},
): Promise<TimestampResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  let respDer: Buffer;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      body: buildTimeStampRequest(anchoredValue),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`TSA ${url} returned HTTP ${res.status}`);
    respDer = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }

  const parsed = asn1js.fromBER(respDer);
  if (parsed.offset === -1) throw new Error("TSA response is not valid DER");
  const resp = new pkijs.TimeStampResp({ schema: parsed.result });
  const status = resp.status.status;
  if (status !== 0 && status !== 1) {
    // 0 = granted, 1 = grantedWithMods; anything else is a rejection.
    throw new Error(`TSA rejected the request (PKIStatus ${status})`);
  }
  if (!resp.timeStampToken) throw new Error("TSA response contained no timeStampToken");
  const tokenDer = Buffer.from(resp.timeStampToken.toSchema().toBER(false));

  // Verify the token we just received before trusting it.
  const verdict = verifyRfc3161Token(tokenDer, anchoredValue, opts.trustPolicy);
  if (!verdict.valid || !verdict.genTime) {
    throw new Error(`TSA token failed verification: ${verdict.error ?? "unknown"}`);
  }
  return { tokenBase64: tokenDer.toString("base64"), genTime: verdict.genTime };
}

export interface TokenVerdict {
  valid: boolean;
  genTime?: string;
  error?: string;
}

/**
 * Verify an RFC 3161 TimeStampToken offline: (1) its CMS signature verifies against the embedded
 * TSA certificate, and (2) its messageImprint equals SHA-256(anchoredValue). Returns the token's
 * genTime on success. A production caller supplies an independently configured certificate pin;
 * trusting only the certificate embedded in the token proves integrity but not TSA identity.
 */
export function verifyRfc3161Token(
  tokenDer: Buffer,
  anchoredValue: string,
  trust?: Rfc3161TrustPolicy | readonly string[],
): TokenVerdict {
  try {
    const parsed = asn1js.fromBER(tokenDer);
    if (parsed.offset === -1) return { valid: false, error: "token is not valid DER" };
    const content = new pkijs.ContentInfo({ schema: parsed.result });
    const sd = new pkijs.SignedData({ schema: content.content });

    const eContent = sd.encapContentInfo.eContent;
    if (sd.encapContentInfo.eContentType !== OID.idCtTSTInfo || !eContent) {
      return { valid: false, error: "token is not a TSTInfo SignedData" };
    }
    const eBytes = Buffer.from((eContent.valueBlock as { valueHexView: Uint8Array }).valueHexView);
    const tstInfo = new pkijs.TSTInfo({ schema: asn1js.fromBER(eBytes).result });

    // (2) messageImprint must equal SHA-256(anchoredValue).
    if (tstInfo.messageImprint.hashAlgorithm.algorithmId !== OID.SHA256) {
      return { valid: false, error: "messageImprint must use SHA-256" };
    }
    const imprint = Buffer.from(
      (tstInfo.messageImprint.hashedMessage.valueBlock as { valueHexView: Uint8Array })
        .valueHexView,
    );
    if (!imprint.equals(sha256(Buffer.from(anchoredValue, "utf8")))) {
      return { valid: false, error: "messageImprint does not match the anchored value" };
    }

    // (1) verify the CMS signature over the signed attributes with the embedded TSA cert.
    if (sd.signerInfos?.length !== 1)
      return { valid: false, error: "token must carry exactly one signerInfo" };
    const si = sd.signerInfos[0]!;
    const attrs = si.signedAttrs?.attributes;
    if (!attrs) return { valid: false, error: "no signed attributes" };

    const hashName = DIGEST_ALGO[si.digestAlgorithm.algorithmId];
    if (!hashName) {
      return {
        valid: false,
        error: `unsupported digest algorithm ${si.digestAlgorithm.algorithmId}`,
      };
    }

    // messageDigest signed-attr must equal hash(eContent).
    const mdAttr = attrs.find((a) => a.type === OID.messageDigest);
    const ctAttr = attrs.find((a) => a.type === OID.contentType);
    if (!mdAttr || !ctAttr)
      return { valid: false, error: "missing contentType/messageDigest attr" };
    const signedContentType = ctAttr.values[0]?.valueBlock.toString();
    if (signedContentType !== OID.idCtTSTInfo) {
      return { valid: false, error: "contentType attr is not id-ct-TSTInfo" };
    }
    const messageDigest = Buffer.from(
      (mdAttr.values[0].valueBlock as { valueHexView: Uint8Array }).valueHexView,
    );
    if (!messageDigest.equals(createHash(hashName).update(eBytes).digest())) {
      return { valid: false, error: "messageDigest attr does not match eContent" };
    }

    if (!sd.certificates?.length)
      return { valid: false, error: "token carries no TSA certificate" };

    // The signature is over the DER of the signed attributes with the implicit [0] tag replaced
    // by the universal SET OF tag (0x31), per CMS.
    const signedAttrsDer = Buffer.from(si.signedAttrs!.toSchema().toBER(false));
    signedAttrsDer[0] = 0x31;
    const signature = Buffer.from(
      (si.signature.valueBlock as { valueHexView: Uint8Array }).valueHexView,
    );
    let x509: X509Certificate | undefined;
    for (const candidate of sd.certificates) {
      if (!(candidate instanceof pkijs.Certificate)) continue;
      const candidateX509 = new X509Certificate(Buffer.from(candidate.toSchema().toBER(false)));
      const valid = createVerify(hashName)
        .update(signedAttrsDer)
        .verify(candidateX509.publicKey, signature);
      if (valid) {
        x509 = candidateX509;
        break;
      }
    }
    if (!x509) return { valid: false, error: "TSA signature is invalid" };

    const genTime = tstInfo.genTime;
    if (!genTime) return { valid: false, error: "token has no genTime" };
    const assertedTime = genTime.getTime();
    if (
      !Number.isFinite(assertedTime) ||
      assertedTime < Date.parse(x509.validFrom) ||
      assertedTime > Date.parse(x509.validTo)
    ) {
      return { valid: false, error: "TSA certificate was not valid at genTime" };
    }
    if (!x509.keyUsage?.includes(OID.timeStampingEku)) {
      return { valid: false, error: "TSA certificate lacks the timeStamping EKU" };
    }

    const policy: Rfc3161TrustPolicy = isRootList(trust)
      ? { trustedRootsPem: trust }
      : (trust ?? {});
    if (policy.trustedCertSha256?.length) {
      const actual = normalizeFingerprint(x509.fingerprint256);
      const pinned = policy.trustedCertSha256.some((value) =>
        fingerprintEquals(actual, normalizeFingerprint(value)),
      );
      if (!pinned) {
        return { valid: false, error: "TSA signing certificate is not enterprise-approved" };
      }
    }

    // Backward-compatible direct root check. This deliberately does not claim general PKIX path
    // building; approved signer pins are the production trust boundary.
    if (policy.trustedRootsPem?.length) {
      const chained = policy.trustedRootsPem.some((pem) => {
        try {
          return x509.verify(new X509Certificate(pem).publicKey);
        } catch {
          return false;
        }
      });
      if (!chained)
        return { valid: false, error: "TSA certificate does not chain to a trusted root" };
    }

    return { valid: true, genTime: genTime.toISOString() };
  } catch (err) {
    return { valid: false, error: `token parse/verify error: ${(err as Error).message}` };
  }
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").trim().toLowerCase();
}

function isRootList(
  trust: Rfc3161TrustPolicy | readonly string[] | undefined,
): trust is readonly string[] {
  return Array.isArray(trust);
}

function fingerprintEquals(actual: string, configured: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(configured)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(configured, "hex"));
}
