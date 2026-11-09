"""Offline verification of a Pharos evidence bundle, in pure Python.

This is the Python counterpart of ``verifyEvidenceBundle`` in
``packages/evidence/src/bundle.ts`` and of the hand-verification recipe in
``docs/security/crypto-review-package.md`` §10.  It needs nothing from Pharos: the bundle
carries the records, the published public keys, and (optionally) trusted-time anchors.

What is checked, record by record, from genesis to head:

* ``content_hash_matches`` — ``sha256(canonical_json(record.content))`` equals
  ``seal.contentHash``.
* ``signature_valid`` — the seal's signature verifies against the keyset entry named by
  ``seal.keyId``, dispatching on the *keyset entry's* algorithm (never ``seal.algorithm``;
  see crypto-review-package.md §11).  ``sigVersion`` 2 signs the domain-separated message
  ``pharos:record-seal:v2\\n<sequence>\\n<prevHash>\\n<contentHash>``; absent/1 signs the
  ASCII hex of ``contentHash`` alone.
* ``chain_link_valid`` — ``seal.prevHash`` equals the previous record's ``contentHash``
  (``"0" * 64`` for sequence 0); sequences are contiguous and the tenant is constant.
* ``seal_algorithm_matches`` — for ``schemaVersion >= 1.1.0`` only, ``seal.algorithm``
  agrees with the keyset entry.  A consistency check, never an input to verification.

Anchors: ``local`` anchors are verified against ``tsaKeyset`` (the TSA signs the ASCII hex
of ``sha256(canonical_json({hash, time}))``).  ``rfc3161`` anchors carry a CMS token whose
verification needs an ASN.1 stack and an independently pinned TSA certificate; this module
does **not** verify them.  They are reported with ``ok: None`` and listed in ``skipped`` so a
caller can hand them to ``npx @getpharos/cli verify --tsa-cert-sha256 …``.

Everything here is a pure function of its arguments — no I/O.  Hashing and canonical JSON
are standard library only; signature verification imports ``cryptography`` lazily so the
SDK's zero-dependency default install is preserved (``pip install 'getpharos[verify]'``).
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

GENESIS_HASH = "0" * 64
"""``prevHash`` of the first record in every tenant chain (``packages/core`` GENESIS_HASH)."""

SEAL_SIGNATURE_V2_PREFIX = b"pharos:record-seal:v2\n"

SEAL_ALGORITHM_TRUTHFUL_FROM = (1, 1, 0)
"""First schema version whose ``seal.algorithm`` must agree with the keyset (ADR 0005)."""

RFC3161_SKIP_MESSAGE = (
    "RFC 3161 token not verified by getpharos; "
    "use `npx @getpharos/cli verify --tsa-cert-sha256 …`"
)

CRYPTOGRAPHY_MISSING = (
    "signature verification needs the 'cryptography' package: pip install 'getpharos[verify]'"
)

# JS Number.prototype.toString switches to exponent notation outside this range.
_JS_MAX_DECIMAL_EXPONENT = 21
_JS_MIN_DECIMAL_EXPONENT = -6
# Integers beyond 2**53 are not exactly representable as a JS number; JSON.parse in the
# reference implementation would already have rounded them to the nearest double.
_JS_MAX_SAFE_INTEGER = 2**53

JsonValue = Union[None, bool, int, float, str, Sequence[Any], Mapping[str, Any]]
KeysetInput = Union[Iterable[Mapping[str, Any]], Mapping[str, Mapping[str, Any]]]


# --------------------------------------------------------------------------------------
# Canonical JSON (packages/core/src/chain/canonical.ts)
# --------------------------------------------------------------------------------------


def _js_number(value: Union[int, float]) -> str:
    """Render a number exactly as ``JSON.stringify`` does (ECMAScript Number::toString)."""
    if isinstance(value, int) and abs(value) <= _JS_MAX_SAFE_INTEGER:
        return str(value)
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Cannot canonicalize non-finite number")
    if number == 0:
        return "0"  # JS prints both +0 and -0 as "0"
    sign = "-" if number < 0 else ""
    # repr() is the shortest round-trip digit string, the same digits JS chooses.
    digits_tuple, exponent = _normalized_digits(Decimal(repr(abs(number))))
    digits = "".join(str(d) for d in digits_tuple)
    k = len(digits)
    n = k + exponent  # value == 0.<digits> * 10**n
    if k <= n <= _JS_MAX_DECIMAL_EXPONENT:
        return sign + digits + "0" * (n - k)
    if 0 < n <= _JS_MAX_DECIMAL_EXPONENT:
        return sign + digits[:n] + "." + digits[n:]
    if _JS_MIN_DECIMAL_EXPONENT < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    exp = ("+" if e >= 0 else "-") + str(abs(e))
    if k == 1:
        return sign + digits + "e" + exp
    return sign + digits[0] + "." + digits[1:] + "e" + exp


def _normalized_digits(value: Decimal) -> Tuple[Tuple[int, ...], int]:
    """Digits with trailing zeros stripped, plus the base-10 exponent of the last digit."""
    _sign, digits, exponent = value.normalize().as_tuple()
    if not isinstance(exponent, int):  # pragma: no cover - finite inputs only
        raise ValueError("Cannot canonicalize non-finite number")
    return tuple(digits), exponent


def _utf16_sort_key(key: str) -> bytes:
    """Sort keys the way ``Array.prototype.sort`` does: by UTF-16 code unit."""
    return key.encode("utf-16-be", "surrogatepass")


def canonical_json(value: JsonValue) -> str:
    """Deterministic canonical JSON: sorted keys (UTF-16 code unit order), no whitespace,
    arrays in order, strings and numbers rendered exactly as ``JSON.stringify`` renders
    them, non-ASCII left unescaped.  Byte-for-byte what ``canonicalize`` in
    ``packages/core`` produces for the same value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, Mapping):
        keys = sorted((str(k) for k in value.keys()), key=_utf16_sort_key)
        entries = [json.dumps(k, ensure_ascii=False) + ":" + canonical_json(value[k]) for k in keys]
        return "{" + ",".join(entries) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    raise ValueError("Cannot canonicalize value of type %s" % type(value).__name__)


def sha256_hex(value: JsonValue) -> str:
    """Lowercase hex SHA-256 over the UTF-8 bytes of ``canonical_json(value)``."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------------------
# Signatures (packages/core/src/signing/provider.ts, chain/verify.ts)
# --------------------------------------------------------------------------------------


def signing_message(seal: Mapping[str, Any], sequence: int) -> bytes:
    """The bytes a seal's signature covers, dispatching on ``seal.sigVersion``."""
    content_hash = str(seal.get("contentHash", ""))
    if int(seal.get("sigVersion") or 1) >= 2:
        prev_hash = str(seal.get("prevHash", ""))
        return (
            SEAL_SIGNATURE_V2_PREFIX
            + ("%d\n%s\n%s" % (int(sequence), prev_hash, content_hash)).encode("utf-8")
        )
    return content_hash.encode("ascii")


def tsa_message(hash_hex: str, time: str) -> bytes:
    """The bytes a ``local`` TSA anchor signs: ASCII hex of ``sha256({hash, time})``."""
    return sha256_hex({"hash": hash_hex, "time": time}).encode("ascii")


def verify_with_key_entry(entry: Mapping[str, Any], message: bytes, signature_b64: str) -> bool:
    """Verify one signature against a published key entry, dispatching on its algorithm.

    Raises ``ImportError`` (with install guidance) when ``cryptography`` is absent, and
    ``ValueError`` for an unknown algorithm or a key that does not match its declared one.
    Returns ``False`` for a well-formed signature that simply does not verify.
    """
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec, ed25519
        from cryptography.hazmat.primitives.serialization import load_der_public_key
    except ImportError as exc:
        raise ImportError(CRYPTOGRAPHY_MISSING) from exc

    public_key = load_der_public_key(base64.b64decode(str(entry["publicKey"])))
    signature = base64.b64decode(signature_b64)
    algorithm = entry.get("algorithm")
    try:
        if algorithm == "ecdsa-p256":
            if not isinstance(public_key, ec.EllipticCurvePublicKey):
                raise ValueError("keyset entry says ecdsa-p256 but the key is not an EC key")
            public_key.verify(signature, message, ec.ECDSA(hashes.SHA256()))
        elif algorithm == "ed25519":
            if not isinstance(public_key, ed25519.Ed25519PublicKey):
                raise ValueError("keyset entry says ed25519 but the key is not an Ed25519 key")
            public_key.verify(signature, message)
        else:
            raise ValueError("unsupported keyset algorithm: %r" % (algorithm,))
    except InvalidSignature:
        return False
    return True


def keyset_by_id(keyset: KeysetInput) -> Dict[str, Mapping[str, Any]]:
    """Index a published keyset (list of entries, or an already-indexed mapping) by keyId."""
    if isinstance(keyset, Mapping):
        return dict(keyset)
    return {str(entry["keyId"]): entry for entry in keyset}


# --------------------------------------------------------------------------------------
# Records and chains (packages/core/src/chain/verify.ts)
# --------------------------------------------------------------------------------------


def _schema_version_tuple(version: Any) -> Tuple[int, ...]:
    try:
        return tuple(int(part) for part in str(version).split("."))
    except ValueError:
        return (0,)


def _record_shape_errors(record: Any) -> List[str]:
    """A light structural check standing in for the zod ``ActionRecordSchema``."""
    errors: List[str] = []
    if not isinstance(record, Mapping):
        return ["record is not an object"]
    content = record.get("content")
    seal = record.get("seal")
    if not isinstance(content, Mapping):
        errors.append("content missing or not an object")
    else:
        for field in ("id", "tenantId"):
            if not isinstance(content.get(field), str) or not content.get(field):
                errors.append("content.%s missing" % field)
        if not isinstance(content.get("sequence"), int) or isinstance(content.get("sequence"), bool):
            errors.append("content.sequence missing or not an integer")
    if not isinstance(seal, Mapping):
        errors.append("seal missing or not an object")
    else:
        for field in ("contentHash", "prevHash", "keyId", "signature"):
            if not isinstance(seal.get(field), str) or not seal.get(field):
                errors.append("seal.%s missing" % field)
    return errors


def verify_record(
    record: Mapping[str, Any],
    prev_hash: str,
    keyset_by_id: Mapping[str, Mapping[str, Any]],
) -> Dict[str, Any]:
    """Verify one record's content hash, signature and chain link against a keyset index.

    Returns ``{ok, record_id, sequence, checks: {schema_valid, content_hash_matches,
    signature_valid, chain_link_valid, seal_algorithm_matches}, errors}``.
    """
    errors = _record_shape_errors(record)
    schema_valid = not errors
    if not schema_valid:
        errors = ["schema invalid: " + "; ".join(errors)]
    content = record.get("content") if isinstance(record, Mapping) else None
    seal = record.get("seal") if isinstance(record, Mapping) else None
    content = content if isinstance(content, Mapping) else {}
    seal = seal if isinstance(seal, Mapping) else {}
    sequence = content.get("sequence")
    sequence = sequence if isinstance(sequence, int) and not isinstance(sequence, bool) else -1

    recomputed = sha256_hex(content)
    sealed_hash = str(seal.get("contentHash", ""))
    content_hash_matches = recomputed == sealed_hash
    if not content_hash_matches:
        errors.append(
            "content hash mismatch: recomputed %s != sealed %s" % (recomputed, sealed_hash)
        )

    key_id = str(seal.get("keyId", ""))
    entry = keyset_by_id.get(key_id)
    signature_valid = False
    if entry is None:
        errors.append("signature invalid: unknown keyId %s" % key_id)
    else:
        try:
            signature_valid = verify_with_key_entry(
                entry, signing_message(seal, sequence), str(seal.get("signature", ""))
            )
            if not signature_valid:
                errors.append("signature invalid: signature mismatch")
        except ImportError:
            raise
        except Exception as exc:  # noqa: BLE001 — reported, never swallowed
            errors.append("signature invalid: signature verification error: %s" % exc)

    chain_link_valid = seal.get("prevHash") == prev_hash
    if not chain_link_valid:
        errors.append(
            "chain link broken: prevHash %s != expected %s" % (seal.get("prevHash"), prev_hash)
        )

    seal_algorithm_matches = True
    if entry is not None and _schema_version_tuple(content.get("schemaVersion")) >= (
        SEAL_ALGORITHM_TRUTHFUL_FROM
    ):
        seal_algorithm_matches = seal.get("algorithm") == entry.get("algorithm")
        if not seal_algorithm_matches:
            errors.append(
                "seal algorithm mismatch: record claims %s but key %s is %s"
                % (seal.get("algorithm"), key_id, entry.get("algorithm"))
            )

    checks = {
        "schema_valid": schema_valid,
        "content_hash_matches": content_hash_matches,
        "signature_valid": signature_valid,
        "chain_link_valid": chain_link_valid,
        "seal_algorithm_matches": seal_algorithm_matches,
    }
    return {
        "ok": all(checks.values()),
        "record_id": content.get("id"),
        "sequence": sequence,
        "checks": checks,
        "errors": errors,
    }


def verify_chain(records: Sequence[Mapping[str, Any]], keyset: KeysetInput) -> Dict[str, Any]:
    """Verify a tenant chain genesis to head.  ``records`` must be in ascending sequence.

    Returns ``{ok, tenant_id, records_checked, first_broken_sequence, records, errors}``.
    """
    keys = keyset_by_id(keyset)
    first = records[0] if records else None
    tenant_id: Optional[str] = None
    if isinstance(first, Mapping) and isinstance(first.get("content"), Mapping):
        tenant_id = first["content"].get("tenantId")

    ok = True
    first_broken: Optional[int] = None
    results: List[Dict[str, Any]] = []
    errors: List[str] = []
    expected_prev = GENESIS_HASH
    expected_seq = 0
    for record in records:
        content = record.get("content") if isinstance(record, Mapping) else None
        content = content if isinstance(content, Mapping) else {}
        sequence = content.get("sequence")
        if sequence != expected_seq:
            ok = False
            errors.append("sequence gap: expected %d, got %s" % (expected_seq, sequence))
            first_broken = sequence if first_broken is None else first_broken
        if tenant_id and content.get("tenantId") != tenant_id:
            ok = False
            errors.append("tenant mismatch at sequence %s" % sequence)
            first_broken = sequence if first_broken is None else first_broken
        result = verify_record(record, expected_prev, keys)
        results.append(result)
        if not result["ok"]:
            ok = False
            first_broken = sequence if first_broken is None else first_broken
            errors.extend("sequence %s: %s" % (sequence, error) for error in result["errors"])
        seal = record.get("seal") if isinstance(record, Mapping) else None
        expected_prev = str(seal.get("contentHash", "")) if isinstance(seal, Mapping) else ""
        expected_seq = (sequence if isinstance(sequence, int) else expected_seq) + 1

    return {
        "ok": ok,
        "tenant_id": tenant_id,
        "records_checked": len(results),
        "first_broken_sequence": first_broken,
        "records": results,
        "errors": errors,
    }


# --------------------------------------------------------------------------------------
# Bundles (packages/evidence/src/bundle.ts)
# --------------------------------------------------------------------------------------


def read_bundle(raw: Any) -> Dict[str, Any]:
    """Shape-check a bundle; raises ``ValueError`` exactly where the TS reader throws."""
    if not isinstance(raw, Mapping):
        raise ValueError("bundle must be a JSON object")
    records = raw.get("records")
    keys = raw.get("keyset", raw.get("keys"))
    if not isinstance(records, list) or not records:
        raise ValueError("bundle must contain a non-empty records array")
    if not isinstance(keys, list) or not keys:
        raise ValueError("bundle must contain a non-empty keyset or keys array")
    tenant_id = raw.get("tenantId")
    if tenant_id is None and isinstance(records[0], Mapping):
        content = records[0].get("content")
        tenant_id = content.get("tenantId") if isinstance(content, Mapping) else None
    return {
        "tenant_id": tenant_id,
        "records": records,
        "keys": keys,
        "anchors": raw.get("anchors") or [],
        "tsa_keys": raw.get("tsaKeyset") or [],
    }


def _verify_local_anchor(anchor: Mapping[str, Any], tsa_keys: Mapping[str, Mapping[str, Any]]) -> bool:
    key_id = anchor.get("keyId")
    signature = anchor.get("signature")
    if not key_id or not signature:
        return False
    entry = tsa_keys.get(str(key_id))
    if entry is None:
        return False
    message = tsa_message(str(anchor.get("hash", "")), str(anchor.get("time", "")))
    try:
        return verify_with_key_entry(entry, message, str(signature))
    except ImportError:
        raise
    except Exception:  # noqa: BLE001 — a malformed anchor is simply not valid
        return False


def verify_bundle(bundle: Mapping[str, Any]) -> Dict[str, Any]:
    """Verify an evidence bundle offline: the chain, then every trusted-time anchor.

    Returns ``{tenant_id, chain, anchors, anchors_ok, ok, errors, skipped}`` where each
    anchor is ``{anchor, kind, ok, covers_head}``.  ``local`` anchors are verified against
    the bundle's ``tsaKeyset``; ``rfc3161`` anchors are **not verified** here — they get
    ``ok: None`` and an entry in ``skipped``.  ``anchors_ok`` is ``False`` only when a
    verified anchor failed, or when no anchor at all (verified or skipped) covers the head.
    ``ok`` is ``chain.ok and anchors_ok``; a caller must also look at ``skipped`` before
    treating the bundle as fully proven.
    """
    parsed = read_bundle(bundle)
    chain = verify_chain(parsed["records"], parsed["keys"])
    errors = list(chain["errors"])
    skipped: List[str] = []
    anchors: List[Dict[str, Any]] = []
    anchors_ok = True

    if parsed["anchors"]:
        head = parsed["records"][-1].get("seal", {})
        head_hash = head.get("contentHash") if isinstance(head, Mapping) else None
        tsa_keys = keyset_by_id(parsed["tsa_keys"])
        head_anchored = False
        head_skipped = False
        for anchor in parsed["anchors"]:
            kind = anchor.get("provider") or "local"
            covers_head = anchor.get("hash") == head_hash
            ok: Optional[bool]
            if kind == "rfc3161":
                ok = None
                skipped.append(RFC3161_SKIP_MESSAGE)
                head_skipped = head_skipped or covers_head
            else:
                ok = _verify_local_anchor(anchor, tsa_keys)
                if not ok:
                    anchors_ok = False
                    errors.append(
                        "anchor over %s… at %s failed verification"
                        % (str(anchor.get("hash", ""))[:12], anchor.get("time"))
                    )
                head_anchored = head_anchored or (ok and covers_head)
            anchors.append({"anchor": anchor, "kind": kind, "ok": ok, "covers_head": covers_head})
        if not head_anchored and not head_skipped:
            anchors_ok = False
            errors.append("no valid anchor covers the head record")

    return {
        "tenant_id": parsed["tenant_id"],
        "chain": chain,
        "anchors": anchors,
        "anchors_ok": anchors_ok,
        "ok": bool(chain["ok"] and anchors_ok),
        "errors": errors,
        "skipped": skipped,
    }


__all__ = [
    "GENESIS_HASH",
    "RFC3161_SKIP_MESSAGE",
    "CRYPTOGRAPHY_MISSING",
    "canonical_json",
    "sha256_hex",
    "signing_message",
    "tsa_message",
    "verify_with_key_entry",
    "keyset_by_id",
    "verify_record",
    "verify_chain",
    "read_bundle",
    "verify_bundle",
]
