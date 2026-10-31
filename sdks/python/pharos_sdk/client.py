"""Pharos Python SDK client.

Submit an agent action for a verdict + sealed evidence record, honoring the verdict
deadline, retrying transient failures, and falling back to a safe local default if the
platform is unreachable. Also drives workflow continuation (await + exactly-once resume).

Dependency-free (stdlib only) so it installs anywhere.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

from .validation import validate_submit_input
from .mandate_token import scope_allows_action_type, verify_mandate_token


class PharosError(Exception):
    def __init__(self, message: str, code: str = "error", status: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.status = status


class PharosBlockedError(Exception):
    def __init__(self, reason: str, citations: Optional[list] = None):
        super().__init__(f"action blocked by Pharos: {reason}")
        self.reason = reason
        self.citations = citations or []


@dataclass
class PharosClient:
    base_url: str
    api_key: str
    deadline_ms: int = 800
    max_retries: int = 2
    local_fail_mode: str = "fail_closed"  # "fail_open" | "fail_closed"
    on_event: Optional[Callable[[Dict[str, Any]], None]] = None
    # MandateToken (Workstream A). The tenant's published mandate root keys (GET /v1/keyset,
    # entries named ``mandate:<tenantId>#vN``) let the SDK refuse a structurally invalid token
    # without a network call. ``mandate_token_local_allow`` (default False) additionally allows a
    # verified token on a reversible, zero-amount, in-scope action locally while the sealed record
    # is submitted; the server verdict is authoritative.
    mandate_token_root_keys: Optional[list] = None
    mandate_token_local_allow: bool = False
    _session: Any = field(default=None, repr=False)

    def _emit(self, event: Dict[str, Any]) -> None:
        if self.on_event:
            self.on_event(event)

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        url = f"{self.base_url}{path}"
        timeout = self.deadline_ms / 1000.0
        last_err: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            data = json.dumps(body).encode() if body is not None else None
            headers = {"x-api-key": self.api_key}
            if data is not None:
                headers["content-type"] = "application/json"
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    payload = json.loads(resp.read().decode() or "{}")
                    return payload.get("data", {})
            except urllib.error.HTTPError as e:
                detail = {}
                try:
                    detail = json.loads(e.read().decode() or "{}")
                except Exception:
                    pass
                if 400 <= e.code < 500:
                    raise PharosError(
                        f"request failed: {detail.get('error', {}).get('code', e.reason)}",
                        detail.get("error", {}).get("code", "client_error"),
                        e.code,
                    )
                last_err = PharosError(f"server error {e.code}", "server_error", e.code)
            except Exception as e:  # noqa: BLE001 - network/timeout
                last_err = e
            if attempt < self.max_retries:
                self._emit({"type": "retry", "attempt": attempt, "error": str(last_err)})
                time.sleep((2 ** attempt) * 0.025)
        raise last_err if last_err else PharosError("request failed")

    def _root_key_for(self, key_id: Any) -> Optional[dict]:
        if not self.mandate_token_root_keys or not isinstance(key_id, str):
            return None
        for entry in self.mandate_token_root_keys:
            if isinstance(entry, dict) and entry.get("keyId") == key_id:
                return entry
        return None

    def _local_token_verdict(self, request: dict, start: float) -> Optional[dict]:
        """Decide locally from the token when root keys are configured; None = server decides."""
        token = request.get("mandateToken")
        if token is None or self.mandate_token_root_keys is None:
            return None
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        key_id = (token.get("authority") or {}).get("keyId") if isinstance(token, dict) else None
        root = self._root_key_for(key_id)
        if root is None:
            ok, code, effective = False, "root-key-unknown", None
        else:
            result = verify_mandate_token(
                token, root, now,
                {"tenantId": request["tenantId"], "agentId": request["action"]["agentId"]},
            )
            ok, code, effective = result.ok, result.code, result.effective
        latency = {"totalMs": (time.time() - start) * 1000, "perTier": {}, "deadlineMs": self.deadline_ms, "deadlineBreached": False}
        if not ok:
            self._emit({"type": "local-verdict", "verdict": "mandate-token-invalid", "code": code})
            return {
                "verdict": {
                    "decision": "block", "tierReached": 1, "riskScore": 1,
                    "ruleCitations": [{
                        "ruleId": "mandate-token-invalid", "pack": "core",
                        "clause": "liability.mandateToken.verification",
                        "description": f"Presented mandate token was refused: {code}.",
                    }],
                    "failMode": None, "judgeVersion": None, "latency": latency,
                },
                "localVerdict": "mandate-token-invalid",
            }
        if not self.mandate_token_local_allow or effective is None:
            return None
        blast = (request.get("liability") or {}).get("blastRadius") or {}
        eligible = (
            blast.get("reversibility") == "reversible"
            and (blast.get("financialAmount") or 0) == 0
            and scope_allows_action_type(effective["scope"], request["action"]["type"])
        )
        if not eligible:
            return None
        self._emit({"type": "local-verdict", "verdict": "mandate-token-allow"})
        return {
            "verdict": {
                "decision": "allow", "tierReached": 1, "riskScore": 0,
                "ruleCitations": [{
                    "ruleId": "mandate-token-local-allow", "pack": "sdk",
                    "clause": "mandateToken.localAllow",
                    "description": "Verified mandate token admitted a reversible, zero-amount, in-scope action locally; the sealed server verdict is authoritative.",
                }],
                "failMode": None, "judgeVersion": None, "latency": latency,
            },
            "localVerdict": "mandate-token-allow",
        }

    def submit(self, **kwargs: Any) -> dict:
        """Submit an action. kwargs: tenantId, action, liability, mandateId?, mandateToken?, idempotencyKey?.

        With a ``mandateToken`` and configured root keys, a structurally invalid token is a
        Tier-1 block returned without a network call; the same request is still submitted so the
        decision has a sealed record. The returned dict then carries ``localVerdict`` and
        ``sealed`` — a ``threading.Thread`` whose ``result`` attribute holds the server's reply
        (or ``error``) once it joins. Call ``result["sealed"].join()`` to wait for the record.
        """
        # Validate BEFORE transmit and before any fail-mode path (#80). This raises rather
        # than falling back: an unvalidated liability would otherwise pick the local
        # fail-mode, so a typo could allow an irreversible action the server never saw.
        validate_submit_input(kwargs)
        start = time.time()
        local = self._local_token_verdict(kwargs, start)
        if local is not None:
            import threading

            def seal() -> None:
                try:
                    thread.result = self._submit_remote(start, kwargs)  # type: ignore[attr-defined]
                    if thread.result["verdict"]["decision"] != local["verdict"]["decision"]:  # type: ignore[attr-defined]
                        self._emit({"type": "local-verdict-diverged", "local": local["verdict"]["decision"], "sealed": thread.result["verdict"]["decision"]})  # type: ignore[attr-defined]
                except Exception as err:  # noqa: BLE001 - surfaced on the thread, never raised here
                    thread.error = err  # type: ignore[attr-defined]
                    self._emit({"type": "local-verdict-diverged", "local": local["verdict"]["decision"], "sealed": None, "error": str(err)})

            thread = threading.Thread(target=seal, name="pharos-seal", daemon=True)
            thread.result = None  # type: ignore[attr-defined]
            thread.error = None  # type: ignore[attr-defined]
            thread.start()
            return {
                "verdict": local["verdict"],
                "record": {"content": {"id": "local", "sequence": -1}},
                "escalation": None,
                "localVerdict": local["localVerdict"],
                "sealed": thread,
            }
        return self._submit_remote(start, kwargs)

    def _submit_remote(self, start: float, kwargs: dict) -> dict:
        try:
            result = self._request("POST", "/v1/actions", kwargs)
            self._emit({"type": "submit", "decision": result["verdict"]["decision"]})
            return result
        except PharosError as e:
            if e.status and 400 <= e.status < 500:
                raise
            return self._local_fallback(start, kwargs)
        except Exception:
            return self._local_fallback(start, kwargs)

    def _local_fallback(self, start: float, request: Optional[dict] = None) -> dict:
        # Platform unreachable (incl. a 503 kms_unavailable): mirror the server cascade —
        # reversible work fails OPEN (allow), irreversible fails CLOSED (escalate); fall back to
        # the configured default when reversibility is unknown.
        reversibility = (
            ((request or {}).get("liability") or {}).get("blastRadius") or {}
        ).get("reversibility")
        if reversibility == "reversible":
            fail_mode = "fail_open"
        elif reversibility == "irreversible":
            fail_mode = "fail_closed"
        else:
            fail_mode = self.local_fail_mode
        self._emit({"type": "fallback", "failMode": fail_mode})
        return {
            "verdict": {
                "decision": "allow" if fail_mode == "fail_open" else "escalate",
                "tierReached": 1,
                "riskScore": 0.5,
                "ruleCitations": [{"ruleId": f"sdk-{fail_mode}", "pack": "sdk"}],
                "failMode": fail_mode,
                "judgeVersion": None,
                "latency": {"totalMs": (time.time() - start) * 1000, "perTier": {}, "deadlineMs": self.deadline_ms, "deadlineBreached": True},
            },
            "record": {"content": {"id": "local", "sequence": -1}},
            "escalation": None,
            "localFallback": True,
        }

    def get_escalation(self, tenant_id: str, escalation_id: str) -> dict:
        return self._request("GET", f"/v1/tenants/{tenant_id}/escalations/{escalation_id}")["escalation"]

    def await_resolution(self, tenant_id: str, escalation_id: str, poll_interval_ms: int = 500, timeout_ms: int = 60000) -> dict:
        deadline = time.time() + timeout_ms / 1000.0
        while True:
            esc = self.get_escalation(tenant_id, escalation_id)
            if esc["status"] != "pending":
                return esc
            if time.time() > deadline:
                raise PharosError("escalation resolution timed out", "resolution_timeout")
            time.sleep(poll_interval_ms / 1000.0)

    def claim(self, tenant_id: str, escalation_id: str, claim_id: Optional[str] = None) -> dict:
        """Claim resume ownership; a stable claim_id is replay-safe after a crash."""
        body = {"claimId": claim_id} if claim_id else None
        result = self._request(
            "POST", f"/v1/tenants/{tenant_id}/escalations/{escalation_id}/claim", body
        )
        self._emit({"type": "resume", "escalationId": escalation_id, "claimed": result["claimed"]})
        return result
