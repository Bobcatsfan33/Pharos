import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { createHash, createVerify, X509Certificate, randomBytes } from "node:crypto";

/**
 * RFC 3161 trusted-timestamp client and offline verifier.
 *
 * We build the TimeStampReq and parse the TimeStampResp/TimeStampToken with pkijs/asn1js
 * (no hand-rolled ASN.1), but verify the token's CMS signature with node:crypto: the token
 * carries the TSA's signing certificate, so verification is fully offline and needs no Pharos
 * infrastructure. Two checks establish trusted time for a hash:
 *   1. the token's messageImprint equals SHA-256 of the anchored value (the token is FOR us), and
 *   2. the token's CMS signature verifies against its embedded TSA certificate (the time is the
 *      TSA's, not ours) — over the signed attributes, whose messageDigest binds the TSTInfo.
 * Verifying the TSA certificate chains to a trusted root is an optional stronger check
 * (`trustedRootsPem`); the core proof is (1) + (2).
 */
const OID = {
  SHA256: "2.16.840.1.101.3.4.2.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  idCtTSTInfo: "1.2.840.113549.1.9.16.1.4",
} as const;

// signerInfo digest algorithm OID → node:crypto hash name.
const DIGEST_ALGO: Record<string, string> = {
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
  "1.3.14.3.2.26": "sha1",
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
  const verdict = verifyRfc3161Token(tokenDer, anchoredValue);
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
 * genTime on success. Optionally, if `trustedRootsPem` is given, also require the TSA certificate
 * to chain to one of them.
 */
export function verifyRfc3161Token(
  tokenDer: Buffer,
  anchoredValue: string,
  trustedRootsPem?: string[],
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
    const imprint = Buffer.from(
      (tstInfo.messageImprint.hashedMessage.valueBlock as { valueHexView: Uint8Array })
        .valueHexView,
    );
    if (!imprint.equals(sha256(Buffer.from(anchoredValue, "utf8")))) {
      return { valid: false, error: "messageImprint does not match the anchored value" };
    }

    // (1) verify the CMS signature over the signed attributes with the embedded TSA cert.
    if (!sd.signerInfos?.length) return { valid: false, error: "no signerInfo" };
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
    const messageDigest = Buffer.from(
      (mdAttr.values[0].valueBlock as { valueHexView: Uint8Array }).valueHexView,
    );
    if (!messageDigest.equals(createHash(hashName).update(eBytes).digest())) {
      return { valid: false, error: "messageDigest attr does not match eContent" };
    }

    if (!sd.certificates?.length)
      return { valid: false, error: "token carries no TSA certificate" };
    const cert = sd.certificates[0] as pkijs.Certificate;
    const certDer = Buffer.from(cert.toSchema().toBER(false));
    const x509 = new X509Certificate(certDer);

    // The signature is over the DER of the signed attributes with the implicit [0] tag replaced
    // by the universal SET OF tag (0x31), per CMS.
    const signedAttrsDer = Buffer.from(si.signedAttrs!.toSchema().toBER(false));
    signedAttrsDer[0] = 0x31;
    const signature = Buffer.from(
      (si.signature.valueBlock as { valueHexView: Uint8Array }).valueHexView,
    );
    const signatureValid = createVerify(hashName)
      .update(signedAttrsDer)
      .verify(x509.publicKey, signature);
    if (!signatureValid) return { valid: false, error: "TSA signature is invalid" };

    // Optional: require the TSA cert to chain to a trusted root.
    if (trustedRootsPem?.length) {
      const chained = trustedRootsPem.some((pem) => {
        try {
          return x509.verify(new X509Certificate(pem).publicKey);
        } catch {
          return false;
        }
      });
      if (!chained)
        return { valid: false, error: "TSA certificate does not chain to a trusted root" };
    }

    const genTime = tstInfo.genTime;
    if (!genTime) return { valid: false, error: "token has no genTime" };
    return { valid: true, genTime: genTime.toISOString() };
  } catch (err) {
    return { valid: false, error: `token parse/verify error: ${(err as Error).message}` };
  }
}
