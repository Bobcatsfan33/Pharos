"""MandateToken verification for SDK holders (Workstream A), stdlib only.

The same rules as ``@pharos/core`` ``mandate-token``: canonical JSON (sorted keys, no
whitespace, ``JSON.stringify`` scalar forms), SHA-256, domain-separated position-bound signing
messages, and the narrowing algebra. Signature verification uses ``cryptography`` when it is
installed and otherwise falls back to a pure-Python Ed25519 (RFC 8032) and ECDSA P-256
implementation, so ``pip install getpharos`` can verify a token offline with no extras. The
conformance vectors in ``packages/core/test/mandate-token/vectors.json`` are the contract.

Everything here is a pure function of its arguments — no I/O.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

MAX_BLOCKS = 16
_AUTHORITY_DOMAIN = "pharos:mandate-token:v1:authority"
_BLOCK_DOMAIN = "pharos:mandate-token:v1:block"
_SEAL_DOMAIN = "pharos:mandate-token:v1:seal"
_REVERSIBILITY = ("reversible", "irreversible", "any")


# --------------------------------------------------------------------------------------
# Canonical JSON (packages/core/src/chain/canonical.ts)
# --------------------------------------------------------------------------------------


def _js_number(value: Any) -> str:
    if isinstance(value, bool):
        raise TypeError("bool is not a number here")
    if isinstance(value, int):
        return str(value)
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Cannot canonicalize non-finite number")
    if number == int(number) and abs(number) < 1e21:
        return str(int(number))
    text = repr(number)
    if "e" in text or "E" in text:
        mantissa, exp = text.lower().split("e")
        exp_int = int(exp)
        sign = "+" if exp_int >= 0 else "-"
        return f"{mantissa}e{sign}{abs(exp_int)}"
    return text


def _js_string(value: str) -> str:
    out = ['"']
    for ch in value:
        code = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif code < 0x20:
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(key: str) -> Tuple[int, ...]:
    # JS sorts keys by UTF-16 code units; Python strings compare by code point.
    return tuple(int.from_bytes(key.encode("utf-16-be")[i : i + 2], "big")
                 for i in range(0, len(key.encode("utf-16-be")), 2))


def canonical_json(value: Any) -> str:
    """Serialize exactly as ``canonicalize`` in ``packages/core`` does."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted((k for k in value.keys() if value[k] is not None or True), key=_utf16_key)
        return "{" + ",".join(f"{_js_string(k)}:{canonical_json(value[k])}" for k in keys) + "}"
    raise TypeError(f"Cannot canonicalize value of type {type(value).__name__}")


def sha256_hex(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------------------
# Base64 (canonical only — a lenient decoder would let two strings name one signature)
# --------------------------------------------------------------------------------------


def _b64decode_strict(text: Any) -> Optional[bytes]:
    if not isinstance(text, str) or not text:
        return None
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return None
    if base64.b64encode(raw).decode("ascii") != text:
        return None
    return raw


def _is_key32(text: Any) -> bool:
    raw = _b64decode_strict(text)
    return raw is not None and len(raw) == 32


# --------------------------------------------------------------------------------------
# Ed25519 (RFC 8032) — pure Python fallback
# --------------------------------------------------------------------------------------

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _ed_point_add(p: Tuple[int, int, int, int], q: Tuple[int, int, int, int]) -> Tuple[int, int, int, int]:
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = (y1 - x1) * (y2 - x2) % _P
    b = (y1 + x1) * (y2 + x2) % _P
    c = 2 * t1 * t2 * _D % _P
    d = 2 * z1 * z2 % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _ed_point_mul(s: int, p: Tuple[int, int, int, int]) -> Tuple[int, int, int, int]:
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _ed_point_add(q, p)
        p = _ed_point_add(p, p)
        s >>= 1
    return q


def _ed_point_equal(p: Tuple[int, int, int, int], q: Tuple[int, int, int, int]) -> bool:
    return (p[0] * q[2] - q[0] * p[2]) % _P == 0 and (p[1] * q[2] - q[1] * p[2]) % _P == 0


def _ed_recover_x(y: int, sign: int) -> Optional[int]:
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P)
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _I % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


_ED_G_Y = 4 * pow(5, _P - 2, _P) % _P
_ED_G_X = _ed_recover_x(_ED_G_Y, 0)
_ED_G = (_ED_G_X, _ED_G_Y, 1, _ED_G_X * _ED_G_Y % _P)  # type: ignore[operator]


def _ed_decompress(s: bytes) -> Optional[Tuple[int, int, int, int]]:
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _ed_recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


def _ed_compress(p: Tuple[int, int, int, int]) -> bytes:
    zinv = pow(p[2], _P - 2, _P)
    x = p[0] * zinv % _P
    y = p[1] * zinv % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _ed25519_verify_pure(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    a = _ed_decompress(public)
    r = _ed_decompress(signature[:32])
    if a is None or r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % _L
    sb = _ed_point_mul(s, _ED_G)
    rha = _ed_point_add(r, _ed_point_mul(h, a))
    return _ed_point_equal(sb, rha)


def _ed25519_public_from_seed(seed: bytes) -> bytes:
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return _ed_compress(_ed_point_mul(a, _ED_G))


# --------------------------------------------------------------------------------------
# ECDSA P-256 (AWS KMS roots) — pure Python fallback, DER signatures, SHA-256
# --------------------------------------------------------------------------------------

_EC_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_EC_A = _EC_P - 3
_EC_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
_EC_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_EC_G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)


def _ec_add(p: Optional[Tuple[int, int]], q: Optional[Tuple[int, int]]) -> Optional[Tuple[int, int]]:
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % _EC_P == 0:
        return None
    if p == q:
        lam = (3 * p[0] * p[0] + _EC_A) * pow(2 * p[1], _EC_P - 2, _EC_P) % _EC_P
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], _EC_P - 2, _EC_P) % _EC_P
    x = (lam * lam - p[0] - q[0]) % _EC_P
    return (x, (lam * (p[0] - x) - p[1]) % _EC_P)


def _ec_mul(k: int, p: Tuple[int, int]) -> Optional[Tuple[int, int]]:
    result: Optional[Tuple[int, int]] = None
    addend: Optional[Tuple[int, int]] = p
    while k > 0:
        if k & 1:
            result = _ec_add(result, addend)
        addend = _ec_add(addend, addend)
        k >>= 1
    return result


def _der_read(buf: bytes, pos: int) -> Tuple[int, bytes, int]:
    tag = buf[pos]
    length = buf[pos + 1]
    pos += 2
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(buf[pos : pos + n], "big")
        pos += n
    return tag, buf[pos : pos + length], pos + length


def _der_ecdsa_signature(sig: bytes) -> Optional[Tuple[int, int]]:
    try:
        tag, body, _ = _der_read(sig, 0)
        if tag != 0x30:
            return None
        t1, r, pos = _der_read(body, 0)
        t2, s, _ = _der_read(body, pos)
        if t1 != 0x02 or t2 != 0x02:
            return None
        return int.from_bytes(r, "big"), int.from_bytes(s, "big")
    except (IndexError, ValueError):
        return None


def _spki_payload(spki: bytes) -> Optional[Tuple[bytes, bytes]]:
    """(algorithm OID bytes, subjectPublicKey bytes) from an SPKI DER blob."""
    try:
        tag, body, _ = _der_read(spki, 0)
        if tag != 0x30:
            return None
        t_alg, alg, pos = _der_read(body, 0)
        t_key, key, _ = _der_read(body, pos)
        if t_alg != 0x30 or t_key != 0x03:
            return None
        t_oid, oid, _ = _der_read(alg, 0)
        if t_oid != 0x06:
            return None
        return oid, key[1:]  # drop the BIT STRING unused-bits byte
    except (IndexError, ValueError):
        return None


_OID_ED25519 = bytes.fromhex("2b6570")
_OID_EC_PUBLIC_KEY = bytes.fromhex("2a8648ce3d0201")


def _ecdsa_p256_verify_pure(point: bytes, message: bytes, signature: bytes) -> bool:
    if len(point) != 65 or point[0] != 4:
        return False
    q = (int.from_bytes(point[1:33], "big"), int.from_bytes(point[33:], "big"))
    rs = _der_ecdsa_signature(signature)
    if rs is None:
        return False
    r, s = rs
    if not (1 <= r < _EC_N and 1 <= s < _EC_N):
        return False
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = pow(s, _EC_N - 2, _EC_N)
    u1 = e * w % _EC_N
    u2 = r * w % _EC_N
    point_sum = _ec_add(_ec_mul(u1, _EC_G), _ec_mul(u2, q))
    return point_sum is not None and point_sum[0] % _EC_N == r


def _verify_root(root: Dict[str, Any], message: bytes, signature_b64: str) -> bool:
    spki = _b64decode_strict(root.get("publicKey"))
    sig = _b64decode_strict(signature_b64)
    if spki is None or sig is None:
        return False
    try:  # fast path when the optional dependency is present
        from cryptography.exceptions import InvalidSignature  # type: ignore
        from cryptography.hazmat.primitives import hashes, serialization  # type: ignore
        from cryptography.hazmat.primitives.asymmetric import ec  # type: ignore

        key = serialization.load_der_public_key(spki)
        try:
            if root.get("algorithm") == "ecdsa-p256":
                key.verify(sig, message, ec.ECDSA(hashes.SHA256()))  # type: ignore[attr-defined]
            else:
                key.verify(sig, message)  # type: ignore[call-arg]
            return True
        except InvalidSignature:
            return False
    except ImportError:
        pass
    parsed = _spki_payload(spki)
    if parsed is None:
        return False
    oid, key_bytes = parsed
    if root.get("algorithm") == "ecdsa-p256":
        return oid == _OID_EC_PUBLIC_KEY and _ecdsa_p256_verify_pure(key_bytes, message, sig)
    return oid == _OID_ED25519 and _ed25519_verify_pure(key_bytes, message, sig)


def _verify_ephemeral(public_b64: str, message: bytes, signature_b64: str) -> bool:
    public = _b64decode_strict(public_b64)
    sig = _b64decode_strict(signature_b64)
    if public is None or sig is None or len(public) != 32:
        return False
    try:
        from cryptography.exceptions import InvalidSignature  # type: ignore
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey  # type: ignore

        try:
            Ed25519PublicKey.from_public_bytes(public).verify(sig, message)
            return True
        except InvalidSignature:
            return False
    except ImportError:
        return _ed25519_verify_pure(public, message, sig)


def _ephemeral_public_of(secret_b64: str) -> Optional[str]:
    seed = _b64decode_strict(secret_b64)
    if seed is None or len(seed) != 32:
        return None
    try:
        from cryptography.hazmat.primitives import serialization  # type: ignore
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # type: ignore

        pub = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
    except ImportError:
        pub = _ed25519_public_from_seed(seed)
    return base64.b64encode(pub).decode("ascii")


# --------------------------------------------------------------------------------------
# Narrowing algebra
# --------------------------------------------------------------------------------------


class Widening(Exception):
    pass


def _is_iso(value: Any) -> bool:
    return isinstance(value, str) and _parse_iso(value) is not None


def _parse_iso(value: str) -> Optional[datetime]:
    try:
        text = value[:-1] + "+00:00" if value.endswith("Z") else value
        dt = datetime.fromisoformat(text)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(x, str) and x for x in value)


def _action_pattern_covered(narrow: str, wide: List[str]) -> bool:
    return any(w == "*" or w == narrow or (w.endswith(".") and narrow.startswith(w)) for w in wide)


def _resource_pattern_covered(narrow: str, wide: List[str]) -> bool:
    return any(w == "*" or w == narrow or (w.endswith("*") and narrow.startswith(w[:-1])) for w in wide)


def scope_allows_action_type(scope: Dict[str, Any], action_type: str) -> bool:
    return any(
        p == "*" or (action_type.startswith(p) if p.endswith(".") else p == action_type)
        for p in scope.get("actionTypes", [])
    )


def _apply_check(cur: Dict[str, Any], check: Any) -> Dict[str, Any]:
    if not isinstance(check, dict):
        raise Widening("check must be an object")
    kind = check.get("kind")
    value = check.get("value")
    out = {**cur, "scope": {**cur["scope"]}, "limits": {**cur["limits"]}}
    if kind == "limit":
        if not isinstance(value, dict):
            raise Widening("limit check must be an object")
        if "financialAmount" in value:
            amt = value["financialAmount"]
            if isinstance(amt, bool) or not isinstance(amt, (int, float)) or not math.isfinite(amt) or amt < 0:
                raise Widening("limit.financialAmount must be a finite number >= 0")
            cur_amt = cur["limits"].get("financialAmount")
            if cur_amt is not None and amt > cur_amt:
                raise Widening(f"limit.financialAmount {amt} widens {cur_amt}")
            out["limits"]["financialAmount"] = amt
        if "currency" in value:
            if not isinstance(value["currency"], str) or not value["currency"]:
                raise Widening("limit.currency must be a string")
            if cur["limits"].get("currency") is not None and value["currency"] != cur["limits"]["currency"]:
                raise Widening("limit.currency widens")
            out["limits"]["currency"] = value["currency"]
        if "reversibility" in value:
            if value["reversibility"] not in _REVERSIBILITY:
                raise Widening("limit.reversibility invalid")
            c = cur["limits"].get("reversibility") or "any"
            if c != "any" and value["reversibility"] != c:
                raise Widening("limit.reversibility widens")
            out["limits"]["reversibility"] = value["reversibility"]
        return out
    if kind == "expiry":
        if not _is_iso(value):
            raise Widening("expiry check must be an ISO date")
        if _parse_iso(value) > _parse_iso(cur["expiresAt"]):  # type: ignore[operator]
            raise Widening("expiry widens")
        out["expiresAt"] = value
        return out
    if kind == "scope":
        if not isinstance(value, dict):
            raise Widening("scope check must be an object")
        if "actionTypes" in value:
            if not _is_string_list(value["actionTypes"]):
                raise Widening("scope.actionTypes must be strings")
            for p in value["actionTypes"]:
                if not _action_pattern_covered(p, cur["scope"]["actionTypes"]):
                    raise Widening(f'scope.actionTypes "{p}" widens')
            out["scope"]["actionTypes"] = list(value["actionTypes"])
        if "resources" in value:
            if not _is_string_list(value["resources"]):
                raise Widening("scope.resources must be strings")
            for p in value["resources"]:
                if not _resource_pattern_covered(p, cur["scope"]["resources"]):
                    raise Widening(f'scope.resources "{p}" widens')
            out["scope"]["resources"] = list(value["resources"])
        return out
    raise Widening(f"unknown check kind {kind!r}")


def _to_effective(a: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "tenantId": a["tenantId"],
        "agentId": a["agentId"],
        "mandateId": a["mandateId"],
        "grantor": a["grantor"],
        "issuedAt": a["issuedAt"],
        "expiresAt": a["expiresAt"],
        "scope": {"actionTypes": list(a["scope"]["actionTypes"]), "resources": list(a["scope"]["resources"])},
        "limits": dict(a["limits"]),
        "citations": list(a["citations"]),
    }


def effective_authority(token: Dict[str, Any]) -> Dict[str, Any]:
    """The intersection of the authority and every block. Raises ``Widening`` on a widening block."""
    eff = _to_effective(token["authority"])
    for block in token["blocks"]:
        for check in block["checks"]:
            eff = _apply_check(eff, check)
    return eff


# --------------------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------------------


@dataclass
class VerifyResult:
    ok: bool
    code: Optional[str]
    errors: List[str] = field(default_factory=list)
    effective: Optional[Dict[str, Any]] = None
    block_hashes: List[str] = field(default_factory=list)
    head_hash: str = ""


def _shape_errors(token: Any) -> List[str]:
    errs: List[str] = []
    if not isinstance(token, dict):
        return ["token is not an object"]
    if token.get("v") != 1:
        errs.append("v must be 1")
    a = token.get("authority")
    if not isinstance(a, dict):
        errs.append("authority missing")
    else:
        for k in ("tenantId", "agentId", "mandateId", "grantor", "keyId"):
            if not isinstance(a.get(k), str) or not a.get(k):
                errs.append(f"authority.{k} missing")
        if not _is_iso(a.get("issuedAt")):
            errs.append("authority.issuedAt not a date")
        if not _is_iso(a.get("expiresAt")):
            errs.append("authority.expiresAt not a date")
        scope = a.get("scope")
        if not isinstance(scope, dict) or not _is_string_list(scope.get("actionTypes")) or not _is_string_list(scope.get("resources")):
            errs.append("authority.scope malformed")
        if not isinstance(a.get("limits"), dict):
            errs.append("authority.limits malformed")
        if not _is_string_list(a.get("citations")):
            errs.append("authority.citations malformed")
        if not _is_key32(a.get("nextKey")):
            errs.append("authority.nextKey not a 32-byte key")
    blocks = token.get("blocks")
    if not isinstance(blocks, list):
        errs.append("blocks must be an array")
    else:
        for i, b in enumerate(blocks):
            if not isinstance(b, dict):
                errs.append(f"blocks[{i}] not an object")
                continue
            if not isinstance(b.get("checks"), list):
                errs.append(f"blocks[{i}].checks must be an array")
            if not _is_iso(b.get("issuedAt")):
                errs.append(f"blocks[{i}].issuedAt not a date")
            if not _is_key32(b.get("nextKey")):
                errs.append(f"blocks[{i}].nextKey not a 32-byte key")
    sigs = token.get("signatures")
    if not isinstance(sigs, list) or not all(_b64decode_strict(s) is not None for s in sigs):
        errs.append("signatures must be canonical base64 strings")
    elif isinstance(blocks, list) and len(sigs) != len(blocks) + 1:
        errs.append(f"signatures: expected {len(blocks) + 1}, got {len(sigs)}")
    proof = token.get("proof")
    if not isinstance(proof, dict):
        errs.append("proof missing")
    elif proof.get("kind") == "next":
        if not _is_key32(proof.get("secret")):
            errs.append("proof.secret not a 32-byte key")
        if len(proof) != 2:
            errs.append("proof has unexpected keys")
    elif proof.get("kind") == "sealed":
        if _b64decode_strict(proof.get("signature")) is None:
            errs.append("proof.signature must be canonical base64")
        if len(proof) != 2:
            errs.append("proof has unexpected keys")
    else:
        errs.append("proof.kind must be next | sealed")
    return errs


def token_block_hashes(token: Dict[str, Any]) -> List[str]:
    return [sha256_hex(token["authority"])] + [sha256_hex(b) for b in token["blocks"]]


def token_head_hash(token: Dict[str, Any]) -> str:
    return sha256_hex({"v": token["v"], "authority": token["authority"], "blocks": token["blocks"], "signatures": token["signatures"]})


def verify_mandate_token(
    token: Any,
    root: Dict[str, Any],
    now: datetime,
    expect: Optional[Dict[str, str]] = None,
    max_blocks: int = MAX_BLOCKS,
) -> VerifyResult:
    """Pure, offline verification against the tenant's published mandate key entry."""
    expect = expect or {}
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    shape = _shape_errors(token)
    if shape:
        return VerifyResult(False, "malformed", shape)
    if len(token["blocks"]) > max_blocks:
        return VerifyResult(False, "too-many-blocks", [f"{len(token['blocks'])} blocks exceeds {max_blocks}"])
    hashes = token_block_hashes(token)
    head = token_head_hash(token)
    a = token["authority"]

    def fail(code: str, msg: str) -> VerifyResult:
        return VerifyResult(False, code, [msg], None, hashes, head)

    if "tenantId" in expect and a["tenantId"] != expect["tenantId"]:
        return fail("tenant-mismatch", f"token tenant {a['tenantId']} != {expect['tenantId']}")
    if "agentId" in expect and a["agentId"] != expect["agentId"]:
        return fail("agent-mismatch", f"token agent {a['agentId']} != {expect['agentId']}")
    if root.get("keyId") != a["keyId"]:
        return fail("root-key-mismatch", f"authority.keyId {a['keyId']} != root {root.get('keyId')}")
    if not _verify_root(root, f"{_AUTHORITY_DOMAIN}\n{hashes[0]}".encode(), token["signatures"][0]):
        return fail("root-signature", "authority signature does not verify against the root key")

    eff = _to_effective(a)
    seen = {a["nextKey"]}
    signer = a["nextKey"]
    for i, block in enumerate(token["blocks"]):
        msg = f"{_BLOCK_DOMAIN}\n{i}\n{hashes[i]}\n{hashes[i + 1]}".encode()
        if not _verify_ephemeral(signer, msg, token["signatures"][i + 1]):
            return fail("block-signature", f"block {i} signature does not verify")
        if block["nextKey"] in seen:
            return fail("key-reuse", f"block {i} republishes an ephemeral key")
        seen.add(block["nextKey"])
        try:
            for check in block["checks"]:
                eff = _apply_check(eff, check)
        except Widening as err:
            return fail("widening", f"block {i}: {err}")
        signer = block["nextKey"]
    proof = token["proof"]
    if proof["kind"] == "next":
        if _ephemeral_public_of(proof["secret"]) != signer:
            return fail("proof", "proof.secret does not match the head's next key")
    elif not _verify_ephemeral(signer, f"{_SEAL_DOMAIN}\n{head}".encode(), proof["signature"]):
        return fail("proof", "seal signature does not verify")
    if _parse_iso(eff["expiresAt"]) <= now:  # type: ignore[operator]
        return fail("expired", f"token expired at {eff['expiresAt']}")
    return VerifyResult(True, None, [], eff, hashes, head)
