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

    def submit(self, **kwargs: Any) -> dict:
        """Submit an action. kwargs: tenantId, action, liability, mandateId?, idempotencyKey?."""
        start = time.time()
        try:
            result = self._request("POST", "/v1/actions", kwargs)
            self._emit({"type": "submit", "decision": result["verdict"]["decision"]})
            return result
        except PharosError as e:
            if e.status and 400 <= e.status < 500:
                raise
            return self._local_fallback(start)
        except Exception:
            return self._local_fallback(start)

    def _local_fallback(self, start: float) -> dict:
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

    def claim(self, tenant_id: str, escalation_id: str) -> dict:
        result = self._request("POST", f"/v1/tenants/{tenant_id}/escalations/{escalation_id}/claim")
        self._emit({"type": "resume", "escalationId": escalation_id, "claimed": result["claimed"]})
        return result
