"""Tamper-evident audit log (P4-6).

A run's event sequence is hashed into a chain — ``h_i = sha256(h_{i-1} || event_i)`` —
computed as a *projection* over the log, so the frozen event envelope is untouched.
``keel audit export`` emits a self-contained bundle (events + chain + optional HMAC
signature over the head); a standalone verifier recomputes the chain and detects any
tampering (a reordered, edited, inserted, or dropped event breaks it).
"""
from __future__ import annotations
import hashlib
import hmac
import json
from typing import Any, Optional
from ..substrate.events import Event
from ..substrate.store.base import GENESIS, chain_hash as _event_hash

BUNDLE_VERSION = "keel-audit/1"


def compute_chain(events: list[Event]) -> list[dict[str, Any]]:
    chain: list[dict[str, Any]] = []
    prev = GENESIS
    for e in events:
        h = _event_hash(prev, e.to_json())
        chain.append({"seq": e.seq, "prev_hash": prev, "hash": h})
        prev = h
    return chain


def head(chain: list[dict[str, Any]]) -> str:
    return str(chain[-1]["hash"]) if chain else GENESIS


def make_bundle(run_id: str, events: list[Event], *, graph: Optional[dict[str, Any]] = None,
                secret: Optional[str] = None) -> dict[str, Any]:
    chain = compute_chain(events)
    h = head(chain)
    bundle: dict[str, Any] = {
        "version": BUNDLE_VERSION,
        "run_id": run_id,
        "graph": graph,
        "events": [json.loads(e.to_json()) for e in events],
        "chain": chain,
        "head": h,
    }
    if secret is not None:
        bundle["signature"] = hmac.new(secret.encode(), h.encode(), hashlib.sha256).hexdigest()
    return bundle


def verify_bundle(bundle: dict[str, Any], *, secret: Optional[str] = None
                  ) -> tuple[bool, str]:
    try:
        events = [Event.model_validate(e) for e in bundle["events"]]
    except Exception as e:  # noqa: BLE001
        return False, f"unparseable events: {e}"
    recomputed = compute_chain(events)
    claimed = bundle.get("chain", [])
    if len(recomputed) != len(claimed):
        return False, f"length mismatch: {len(recomputed)} events vs {len(claimed)} chain links"
    for r, c in zip(recomputed, claimed):
        if r["hash"] != c.get("hash") or r["prev_hash"] != c.get("prev_hash"):
            return False, f"chain broken at seq {r['seq']} (event tampered or reordered)"
    if head(recomputed) != bundle.get("head"):
        return False, "head hash mismatch"
    if secret is not None:
        expected = hmac.new(secret.encode(), head(recomputed).encode(),
                            hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, str(bundle.get("signature", ""))):
            return False, "signature mismatch"
    return True, f"verified {len(recomputed)} events; head={head(recomputed)[:12]}"


def verify_bundle_report(bundle: dict[str, Any], *, secret: Optional[str] = None
                         ) -> dict[str, Any]:
    """Machine-readable verification result for CI and external assessors."""
    ok, detail = verify_bundle(bundle, secret=secret)
    events = bundle.get("events", [])
    chain = bundle.get("chain", [])
    return {
        "ok": ok,
        "status": "OK" if ok else "TAMPERED",
        "detail": detail,
        "version": bundle.get("version"),
        "run_id": bundle.get("run_id"),
        "event_count": len(events) if isinstance(events, list) else 0,
        "chain_links": len(chain) if isinstance(chain, list) else 0,
        "head": bundle.get("head"),
        "signed": "signature" in bundle,
        "signature_checked": secret is not None,
    }
