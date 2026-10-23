"""`pharos verify` in pure Python: the verifier must agree with the TypeScript reference on
the committed fixtures, fail on every kind of tampering at the right sequence, skip (not
fake) RFC 3161 anchors, and delegate sealing commands to the Node CLI honestly.

These tests need the `cryptography` extra; CI installs it so nothing here skips.
"""
import copy
import base64
import json
import os
import sys
from pathlib import Path

import pytest

from pharos_sdk import cli
from pharos_sdk.verify import (
    CRYPTOGRAPHY_MISSING,
    GENESIS_HASH,
    RFC3161_SKIP_MESSAGE,
    canonical_json,
    sha256_hex,
    signing_message,
    verify_bundle,
    verify_chain,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_FIXTURES = REPO_ROOT / "test" / "fixtures"
PY_FIXTURES = Path(__file__).resolve().parent / "fixtures"

ED25519 = TS_FIXTURES / "bundle-ed25519.json"
ECDSA = TS_FIXTURES / "bundle-ecdsa-p256.json"
RFC3161 = TS_FIXTURES / "bundle-ecdsa-p256-rfc3161-anchored.json"
# `pharos demo --out` output (3 records, schema 1.1.0, a `local` anchor + tsaKeyset), the
# same shape as the repo-root evidence-bundle.json the README tells a reader to verify.
LOCAL_ANCHORED = PY_FIXTURES / "evidence-bundle-local-anchored.json"

ALL_PASSING = [ED25519, ECDSA, RFC3161, LOCAL_ANCHORED]


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------------------
# canonical JSON == packages/core canonicalize
# --------------------------------------------------------------------------------------

# Produced on 2026-10-22 from the repo root with:
#   pnpm exec tsx -e 'import { canonicalize, sha256Hex } from "./packages/core/src/chain/canonical.ts";
#     const v = {...the object below, with -0 / 1e21 / 1e-7 / 123456789012345680000 as JS numbers...};
#     console.log(JSON.stringify(canonicalize(v))); console.log(sha256Hex(v));'
# The value exercises: empty key, numeric-looking key, UTF-16 key ordering ("~" < "ünï",
# "é" < "😀"), escaped quote/backslash/newline/tab, unescaped non-ASCII, -0 -> 0,
# 1e21 -> 1e+21, 1e-7 -> 1e-7, an integer beyond 2**53 rounded as a JS double, an
# integral float (JS has no int/float split), bool, null, and nested empty containers.
TS_CANONICAL = (
    '{"":{},"1":"numeric key","alpha":{"Z":0,"_":1,"a":[],"b":"quote\\"back\\\\slash\\n\\t",'
    '"~":2,"ünï":"héllo wörld — ✓ 日本語"},"zeta":[1,2.5,0,1e+21,1e-7,123456789012345680000,'
    'true,null,"x"],"é":"last?","😀":"astral"}'
)
TS_SHA256 = "5926e39ab1a677dc689fe7ee00d0625582db830add2a1d75a5fed342a9bab5bf"

NESTED_VALUE = {
    "zeta": [1, 2.5, -0.0, 1e21, 1e-7, 123456789012345678901, True, None, "x"],
    "alpha": {
        "ünï": "héllo wörld — ✓ 日本語",
        "b": 'quote"back\\slash\n\t',
        "a": [],
        "Z": 0,
        "_": 1,
        "~": 2,
    },
    "": {},
    "é": "last?",
    "1": "numeric key",
    "😀": "astral",
}


def test_canonical_json_matches_typescript_reference():
    assert canonical_json(NESTED_VALUE) == TS_CANONICAL
    assert sha256_hex(NESTED_VALUE) == TS_SHA256


@pytest.mark.parametrize(
    "value, expected",
    [
        (30000.0, "30000"),  # JSON.parse gives a double; JS prints integral doubles bare
        (1.0, "1"),
        (0.1, "0.1"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (-1.5e-10, "-1.5e-10"),
        (5e-324, "5e-324"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (-0.0, "0"),
        (2**53 + 1, "9007199254740992"),
    ],
)
def test_numbers_render_like_json_stringify(value, expected):
    assert canonical_json(value) == expected


def test_canonical_json_rejects_non_finite():
    with pytest.raises(ValueError):
        canonical_json(float("nan"))
    with pytest.raises(ValueError):
        canonical_json({"a": float("inf")})


def test_signing_message_dispatches_on_sig_version():
    seal = {"contentHash": "ab" * 32, "prevHash": GENESIS_HASH, "sigVersion": 2}
    assert signing_message(seal, 7) == (
        b"pharos:record-seal:v2\n7\n" + GENESIS_HASH.encode() + b"\n" + b"ab" * 32
    )
    assert signing_message({"contentHash": "ab" * 32, "prevHash": GENESIS_HASH}, 7) == b"ab" * 32
    assert signing_message({"contentHash": "ab" * 32, "sigVersion": 1}, 0) == b"ab" * 32


# --------------------------------------------------------------------------------------
# the fixtures the TypeScript reference passes must pass here too
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", ALL_PASSING, ids=lambda p: p.name)
def test_fixture_bundles_verify(path):
    report = verify_bundle(load(path))
    assert report["chain"]["ok"] is True
    assert report["chain"]["first_broken_sequence"] is None
    assert report["chain"]["records_checked"] == len(load(path)["records"])
    assert all(r["ok"] for r in report["chain"]["records"])
    assert report["anchors_ok"] is True
    assert report["ok"] is True
    assert report["errors"] == []


def test_local_anchor_is_verified_against_tsa_keyset():
    report = verify_bundle(load(LOCAL_ANCHORED))
    assert [(a["kind"], a["ok"], a["covers_head"]) for a in report["anchors"]] == [
        ("local", True, True)
    ]
    assert report["skipped"] == []


def test_rfc3161_anchor_is_skipped_not_faked():
    report = verify_bundle(load(RFC3161))
    assert report["chain"]["ok"] is True
    assert [(a["kind"], a["ok"], a["covers_head"]) for a in report["anchors"]] == [
        ("rfc3161", None, True)
    ]
    assert report["anchors_ok"] is True
    assert report["skipped"] == [RFC3161_SKIP_MESSAGE]
    assert "npx @getpharos/cli verify --tsa-cert-sha256" in report["skipped"][0]


# --------------------------------------------------------------------------------------
# tampering is caught at the right sequence, by the right check
# --------------------------------------------------------------------------------------


def test_mutated_payload_fails_content_hash_at_that_sequence():
    bundle = copy.deepcopy(load(ED25519))
    bundle["records"][2]["content"]["action"]["payload"]["tampered"] = True
    report = verify_bundle(bundle)
    chain = report["chain"]
    assert report["ok"] is False
    assert chain["ok"] is False
    assert chain["first_broken_sequence"] == 2
    broken = chain["records"][2]
    assert broken["checks"]["content_hash_matches"] is False
    assert broken["checks"]["chain_link_valid"] is True
    assert any(e.startswith("sequence 2: content hash mismatch") for e in chain["errors"])
    # Records before the mutation are untouched.
    assert chain["records"][0]["ok"] and chain["records"][1]["ok"]


@pytest.mark.parametrize("path", [ED25519, ECDSA], ids=lambda p: p.name)
def test_flipped_signature_byte_fails_signature_only(path):
    bundle = copy.deepcopy(load(path))
    seal = bundle["records"][1]["seal"]
    raw = bytearray(base64.b64decode(seal["signature"]))
    raw[-1] ^= 0x01
    seal["signature"] = base64.b64encode(bytes(raw)).decode()
    chain = verify_chain(bundle["records"], bundle["keyset"])
    assert chain["ok"] is False
    assert chain["first_broken_sequence"] == 1
    checks = chain["records"][1]["checks"]
    assert checks["signature_valid"] is False
    assert checks["content_hash_matches"] is True
    assert checks["chain_link_valid"] is True
    assert any("sequence 1: signature invalid" in e for e in chain["errors"])


def test_broken_link_fails_chain_link():
    bundle = copy.deepcopy(load(ED25519))
    bundle["records"][3]["seal"]["prevHash"] = "f" * 64
    chain = verify_chain(bundle["records"], bundle["keyset"])
    assert chain["ok"] is False
    assert chain["first_broken_sequence"] == 3
    assert chain["records"][3]["checks"]["chain_link_valid"] is False
    assert chain["records"][3]["checks"]["content_hash_matches"] is True
    assert any("sequence 3: chain link broken" in e for e in chain["errors"])


def test_spliced_record_fails_link_and_sequence():
    bundle = copy.deepcopy(load(ED25519))
    del bundle["records"][1]
    chain = verify_chain(bundle["records"], bundle["keyset"])
    assert chain["ok"] is False
    assert chain["first_broken_sequence"] == 2
    assert any(e.startswith("sequence gap: expected 1, got 2") for e in chain["errors"])


def test_unknown_key_id_is_a_signature_failure():
    bundle = copy.deepcopy(load(ED25519))
    bundle["records"][0]["seal"]["keyId"] = "nobody#v9"
    chain = verify_chain(bundle["records"], bundle["keyset"])
    assert chain["records"][0]["checks"]["signature_valid"] is False
    assert any("unknown keyId nobody#v9" in e for e in chain["errors"])


def test_tampered_local_anchor_fails_anchors():
    bundle = copy.deepcopy(load(LOCAL_ANCHORED))
    bundle["anchors"][0]["time"] = "1999-01-01T00:00:00.000Z"
    report = verify_bundle(bundle)
    assert report["chain"]["ok"] is True
    assert report["anchors"][0]["ok"] is False
    assert report["anchors_ok"] is False
    assert report["ok"] is False
    assert any("failed verification" in e for e in report["errors"])
    assert "no valid anchor covers the head record" in report["errors"]


def test_seal_algorithm_mismatch_is_enforced_from_schema_1_1():
    bundle = copy.deepcopy(load(LOCAL_ANCHORED))  # schemaVersion 1.1.0
    assert bundle["records"][0]["content"]["schemaVersion"] == "1.1.0"
    # `seal.algorithm` is outside `content`, so this does not break the hash or signature;
    # the consistency check alone must catch it.
    bundle["records"][0]["seal"]["algorithm"] = "ecdsa-p256"
    chain = verify_chain(bundle["records"], bundle["keyset"])
    checks = chain["records"][0]["checks"]
    assert checks["content_hash_matches"] and checks["signature_valid"]
    assert checks["seal_algorithm_matches"] is False
    assert chain["ok"] is False
    # The 1.0.0 ECDSA fixtures misstate `seal.algorithm` as ed25519 (issue #67) and must
    # still verify: the field is informational below 1.1.0.
    legacy = load(ECDSA)
    assert legacy["records"][0]["seal"]["algorithm"] == "ed25519"
    assert verify_chain(legacy["records"], legacy["keyset"])["ok"] is True


@pytest.mark.parametrize(
    "raw, message",
    [
        ({"keyset": [{"keyId": "k"}]}, "non-empty records array"),
        ({"records": []}, "non-empty records array"),
        ({"records": [{}]}, "non-empty keyset or keys array"),
        ([], "bundle must be a JSON object"),
    ],
)
def test_malformed_bundle_raises(raw, message):
    with pytest.raises(ValueError, match=message):
        verify_bundle(raw)


def test_missing_cryptography_gives_install_guidance(monkeypatch):
    for name in [
        "cryptography",
        "cryptography.exceptions",
        "cryptography.hazmat",
        "cryptography.hazmat.primitives",
        "cryptography.hazmat.primitives.hashes",
        "cryptography.hazmat.primitives.asymmetric",
        "cryptography.hazmat.primitives.asymmetric.ec",
        "cryptography.hazmat.primitives.asymmetric.ed25519",
        "cryptography.hazmat.primitives.serialization",
    ]:
        monkeypatch.setitem(sys.modules, name, None)
    with pytest.raises(ImportError) as raised:
        verify_bundle(load(ED25519))
    assert str(raised.value) == CRYPTOGRAPHY_MISSING
    assert "pip install 'getpharos[verify]'" in str(raised.value)


# --------------------------------------------------------------------------------------
# the command line
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", [ED25519, ECDSA, LOCAL_ANCHORED], ids=lambda p: p.name)
def test_cli_verify_passes_with_exit_0(path, capsys):
    assert cli.main(["verify", str(path)]) == 0
    out = capsys.readouterr().out
    n = len(load(path)["records"])
    assert "chain: PASS — %d records, admissible" % n in out
    assert "seq   0  hash ok   sig ok   link ok" in out
    assert "BAD" not in out and "skipped" not in out


def test_cli_verify_local_anchor_report_lines(capsys):
    assert cli.main(["verify", str(LOCAL_ANCHORED)]) == 0
    out = capsys.readouterr().out
    assert "anchor [local]" in out and "(head)" in out
    assert "anchors: PASS — the head existed before the stamped time" in out


def test_cli_verify_rfc3161_fixture_exits_2_and_says_skipped(capsys):
    assert cli.main(["verify", str(RFC3161)]) == 2
    out = capsys.readouterr().out
    assert "chain: PASS — 4 records, admissible" in out
    assert "anchor [rfc3161]" in out and "skipped" in out
    assert "skipped: " + RFC3161_SKIP_MESSAGE in out
    assert "anchors: PASS" not in out  # nothing claimed that was not proven


def test_cli_verify_tampered_bundle_exits_1(tmp_path, capsys):
    bundle = copy.deepcopy(load(ED25519))
    bundle["records"][1]["content"]["action"]["payload"]["tampered"] = True
    path = tmp_path / "tampered.json"
    path.write_text(json.dumps(bundle), encoding="utf-8")
    assert cli.main(["verify", str(path)]) == 1
    out = capsys.readouterr().out
    assert "seq   1  hash BAD" in out
    assert "chain: FAIL — " in out


def test_cli_verify_json_report(capsys):
    assert cli.main(["verify", str(RFC3161), "--json"]) == 2
    report = json.loads(capsys.readouterr().out)
    assert report["ok"] is True and report["chain"]["ok"] is True
    assert report["skipped"] == [RFC3161_SKIP_MESSAGE]
    assert report["anchors"][0]["ok"] is None


def test_cli_verify_unreadable_bundle(tmp_path, capsys):
    assert cli.main(["verify", str(tmp_path / "missing.json")]) == 1
    assert "cannot read bundle" in capsys.readouterr().err


def test_cli_version_and_usage(capsys):
    assert cli.main(["--version"]) == 0
    assert capsys.readouterr().out.strip() != ""
    assert cli.main([]) == 2
    assert "usage: pharos" in capsys.readouterr().err
    assert cli.main(["--help"]) == 0
    out = capsys.readouterr().out
    for name in ("verify", "init", "demo", "run", "serve", "log", "export"):
        assert name in out


@pytest.mark.parametrize("command", cli.NODE_COMMANDS)
def test_cli_node_commands_without_npx_exit_69(command, monkeypatch, capsys):
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    assert cli.main([command]) == 69
    err = capsys.readouterr().err
    assert err.strip() == cli.NODE_MISSING_MESSAGE.format(cmd=command)
    assert "needs Node >= 22.13" in err and "`pharos verify` works with Python alone" in err


def test_cli_node_commands_exec_npx(monkeypatch):
    seen = {}
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/npx" if name == "npx" else None)

    def fake_execvp(file, argv):
        seen["file"], seen["argv"] = file, argv
        raise RuntimeError("exec")  # execvp never returns on success

    monkeypatch.setattr(os, "execvp", fake_execvp)
    with pytest.raises(RuntimeError):
        cli.main(["run", "--", "echo", "governed hello"])
    assert seen["file"] == "/usr/bin/npx"
    assert seen["argv"] == ["npx", "-y", "@getpharos/cli", "run", "--", "echo", "governed hello"]
