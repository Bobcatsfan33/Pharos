"""Pharos governance at Keel's durable step boundary.

Every step is submitted with a stable idempotency key before it is scheduled.  An
allow/modify verdict continues, a block fails the run, and an escalation parks the
run until Pharos has a human resolution.  Re-running ``keel resume`` replays the
same Pharos record and uses a stable claim identity, so a process crash cannot lose
an approval or authorize a second runtime.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Protocol

import httpx

from ..executor.engine import FatalError, GatePaused, RunContext
from ..kir.schema import Node, NodeType
from ..substrate.events import EventType

OversightMode = Literal["autonomous", "human_in_loop", "human_on_loop"]
Reversibility = Literal["reversible", "irreversible"]
FailureMode = Literal["fail_closed", "fail_open"]


@dataclass(frozen=True)
class PharosConfig:
    """Connection and safe local-failure behavior for the unified control plane."""

    base_url: str
    api_key: str
    tenant_id: str
    agent_id: str = "keel-runtime"
    deadline_ms: int = 800
    max_retries: int = 2
    failure_mode: FailureMode = "fail_closed"

    def __post_init__(self) -> None:
        if not self.base_url.strip() or not self.api_key.strip() or not self.tenant_id.strip():
            raise ValueError("Pharos base_url, api_key, and tenant_id must be non-empty")
        if self.deadline_ms <= 0:
            raise ValueError("Pharos deadline_ms must be positive")
        if self.max_retries < 0:
            raise ValueError("Pharos max_retries must not be negative")
        if self.failure_mode not in {"fail_closed", "fail_open"}:
            raise ValueError("Pharos failure_mode must be fail_closed or fail_open")


class PharosError(RuntimeError):
    def __init__(self, message: str, *, code: str = "pharos_error", retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class PharosClientPort(Protocol):
    async def submit(self, body: Mapping[str, Any]) -> dict[str, Any]: ...

    async def claim(
        self, tenant_id: str, escalation_id: str, claim_id: str
    ) -> dict[str, Any]: ...

    async def close(self) -> None: ...


class PharosHttpClient:
    """Small async protocol client; Keel does not require either Pharos SDK package."""

    def __init__(
        self, config: PharosConfig, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._config = config
        self._client = httpx.AsyncClient(
            base_url=config.base_url.rstrip("/"),
            headers={"x-api-key": config.api_key},
            timeout=config.deadline_ms / 1000,
            transport=transport,
        )

    async def submit(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/v1/actions", body)

    async def claim(
        self, tenant_id: str, escalation_id: str, claim_id: str
    ) -> dict[str, Any]:
        path = f"/v1/tenants/{tenant_id}/escalations/{escalation_id}/claim"
        return await self._request("POST", path, {"claimId": claim_id})

    async def _request(
        self, method: str, path: str, body: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(self._config.max_retries + 1):
            try:
                response = await self._client.request(method, path, json=body)
                payload = response.json()
                if 400 <= response.status_code < 500:
                    error = payload.get("error") if isinstance(payload, dict) else None
                    code = error.get("code", "client_error") if isinstance(error, dict) else "client_error"
                    raise PharosError(
                        f"Pharos rejected the governance request ({code})",
                        code=str(code),
                        retryable=False,
                    )
                if response.status_code >= 500:
                    raise PharosError(
                        f"Pharos returned HTTP {response.status_code}",
                        code="server_error",
                        retryable=True,
                    )
                if not isinstance(payload, dict) or payload.get("success") is not True:
                    raise PharosError(
                        "Pharos returned an invalid response envelope",
                        code="invalid_response",
                        retryable=True,
                    )
                data = payload.get("data")
                if not isinstance(data, dict):
                    raise PharosError(
                        "Pharos response did not contain data",
                        code="invalid_response",
                        retryable=True,
                    )
                return data
            except PharosError as error:
                if not error.retryable:
                    raise
                last_error = error
            except (httpx.HTTPError, json.JSONDecodeError) as error:
                last_error = error
            if attempt < self._config.max_retries:
                await asyncio.sleep(0.025 * (2**attempt))
        raise PharosError(
            f"Pharos is unavailable: {type(last_error).__name__}",
            code="unavailable",
            retryable=True,
        ) from last_error

    async def close(self) -> None:
        await self._client.aclose()


class PharosGovernance:
    """Keel ``StepInterceptor`` backed by Pharos verdicts and sealed evidence."""

    def __init__(self, config: PharosConfig, client: PharosClientPort | None = None) -> None:
        self._config = config
        self._client: PharosClientPort = client or PharosHttpClient(config)
        self._owns_client = client is None

    async def before_step(self, ctx: RunContext, node: Node) -> Node | None:
        request = self._request_for(ctx, node)
        idempotency_key = str(request["idempotencyKey"])
        await ctx.emit(
            EventType.GOVERNANCE_REQUESTED,
            node_id=node.id,
            data={
                "provider": "pharos",
                "action_type": request["action"]["type"],
                "idempotency_key": idempotency_key,
                "request_hash": _digest(request),
            },
        )

        try:
            submitted = await self._client.submit(request)
            verdict = _mapping(submitted.get("verdict"), "verdict")
            decision = _string(verdict.get("decision"), "verdict.decision")
            if decision not in {"allow", "block", "modify", "escalate"}:
                raise PharosError("Pharos returned an unknown decision", code="invalid_response")
            evidence = _evidence(submitted)

            if decision == "block":
                await self._emit_decision(ctx, node, decision, verdict, evidence)
                raise FatalError(_blocked_message(verdict))
            if decision in {"allow", "modify"}:
                await self._emit_decision(ctx, node, decision, verdict, evidence)
                return None

            escalation = _mapping(submitted.get("escalation"), "escalation")
            escalation_id = _string(escalation.get("id"), "escalation.id")
            status = _string(escalation.get("status"), "escalation.status")
            if status == "pending":
                await ctx.emit(
                    EventType.GOVERNANCE_ESCALATED,
                    node_id=node.id,
                    data={**evidence, "escalation_id": escalation_id, "status": status},
                )
                await self._pause(ctx, node, f"pharos escalation {escalation_id} is pending")
            if status in {"rejected", "cancelled"}:
                await self._emit_decision(ctx, node, "block", verdict, evidence)
                raise FatalError(f"Pharos escalation {escalation_id} was {status}")
            if status not in {"approved", "modified"}:
                raise PharosError(
                    "Pharos returned an unknown escalation status", code="invalid_response"
                )

            claim_id = _stable_id("claim", self._config.tenant_id, ctx.run_id, node.id)
            claim = await self._client.claim(self._config.tenant_id, escalation_id, claim_id)
            if claim.get("claimed") is not True:
                raise FatalError(
                    f"Pharos escalation {escalation_id} is owned by another continuation"
                )
            await self._emit_decision(ctx, node, status, verdict, evidence, escalation_id)
            return self._modified_node(node, claim) if status == "modified" else None
        except GatePaused:
            raise
        except FatalError:
            raise
        except PharosError as error:
            if not error.retryable:
                raise FatalError(f"Pharos governance error ({error.code})") from error
            await ctx.emit(
                EventType.GOVERNANCE_UNAVAILABLE,
                node_id=node.id,
                data={"provider": "pharos", "code": error.code},
            )
            if self._config.failure_mode == "fail_open":
                await ctx.emit(
                    EventType.GOVERNANCE_DECIDED,
                    node_id=node.id,
                    data={
                        "provider": "pharos",
                        "decision": "allow",
                        "local_fallback": True,
                        "fail_mode": "fail_open",
                    },
                )
                return None
            await self._pause(ctx, node, "Pharos is unavailable (fail-closed)")
        return None

    async def after_step(
        self,
        ctx: RunContext,
        node: Node,
        cost_usd: float,
        tokens_in: int,
        tokens_out: int,
    ) -> None:
        # STEP_COMPLETED is the execution outcome. GOVERNANCE_DECIDED immediately before
        # STEP_SCHEDULED contains the Pharos evidence binding, so the append-only Keel log
        # joins authorization and outcome without a second, ambiguous audit submission.
        return None

    async def close(self) -> None:
        if self._owns_client:
            await self._client.close()

    async def _pause(self, ctx: RunContext, node: Node, reason: str) -> None:
        await ctx.emit(
            EventType.RUN_PAUSED,
            node_id=node.id,
            data={"reason": reason, "source": "pharos"},
        )
        ctx.state.status = "paused"
        raise GatePaused(reason)

    async def _emit_decision(
        self,
        ctx: RunContext,
        node: Node,
        decision: str,
        verdict: Mapping[str, Any],
        evidence: dict[str, Any],
        escalation_id: str | None = None,
    ) -> None:
        data: dict[str, Any] = {
            **evidence,
            "provider": "pharos",
            "decision": decision,
            "risk_score": verdict.get("riskScore"),
            "tier_reached": verdict.get("tierReached"),
            "rule_citations": verdict.get("ruleCitations", []),
        }
        if escalation_id is not None:
            data["escalation_id"] = escalation_id
        await ctx.emit(EventType.GOVERNANCE_DECIDED, node_id=node.id, data=data)

    def _request_for(self, ctx: RunContext, node: Node) -> dict[str, Any]:
        raw = node.config.get("pharos", {})
        if not isinstance(raw, dict):
            raise FatalError(f"node {node.id}: config.pharos must be an object")

        oversight = raw.get("oversight_mode", _default_oversight(node.type))
        reversibility = raw.get("reversibility", _default_reversibility(node.type))
        if oversight not in {"autonomous", "human_in_loop", "human_on_loop"}:
            raise FatalError(f"node {node.id}: invalid Pharos oversight_mode")
        if reversibility not in {"reversible", "irreversible"}:
            raise FatalError(f"node {node.id}: invalid Pharos reversibility")
        amount = raw.get("financial_amount", 0)
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount < 0:
            raise FatalError(f"node {node.id}: Pharos financial_amount must be non-negative")

        supplied_payload = raw.get("payload", {})
        if not isinstance(supplied_payload, dict):
            raise FatalError(f"node {node.id}: config.pharos.payload must be an object")
        action_type = raw.get("action_type", f"keel.step.{node.type.value}")
        if not isinstance(action_type, str) or not action_type:
            raise FatalError(f"node {node.id}: Pharos action_type must be a non-empty string")

        node_hash = _digest(node.model_dump(mode="json"))
        request: dict[str, Any] = {
            "tenantId": self._config.tenant_id,
            "action": {
                "type": action_type,
                "agentId": self._config.agent_id,
                "sessionId": ctx.run_id,
                "payload": {
                    **supplied_payload,
                    "keel": {
                        "runId": ctx.run_id,
                        "graphId": ctx.state.graph.graph_id,
                        "nodeId": node.id,
                        "nodeType": node.type.value,
                        "nodeHash": node_hash,
                    },
                },
            },
            "liability": {
                "mandate": None,
                "oversightMode": oversight,
                "blastRadius": {
                    "financialAmount": amount,
                    "currency": raw.get("currency", "USD"),
                    "reversibility": reversibility,
                    "notes": raw.get("notes", f"Keel step {node.id}"),
                },
                "modelMetadata": raw.get("model_metadata"),
            },
            "idempotencyKey": _stable_id(
                "authorize", self._config.tenant_id, ctx.run_id, node.id
            ),
        }
        mandate_id = raw.get("mandate_id")
        if mandate_id is not None:
            if not isinstance(mandate_id, str) or not mandate_id:
                raise FatalError(f"node {node.id}: Pharos mandate_id must be a non-empty string")
            request["mandateId"] = mandate_id
        return request

    @staticmethod
    def _modified_node(node: Node, claim: Mapping[str, Any]) -> Node | None:
        resolution = claim.get("resolution")
        if not isinstance(resolution, dict):
            return None
        action = resolution.get("modifiedAction")
        if not isinstance(action, dict):
            return None
        payload = action.get("payload")
        if not isinstance(payload, dict) or "keelConfig" not in payload:
            return None
        config = payload["keelConfig"]
        if not isinstance(config, dict):
            raise FatalError("Pharos modifiedAction.payload.keelConfig must be an object")
        # Keep governance declarations attached across retries, while the approved
        # Keel config replaces the executable portion of this step.
        if "pharos" in node.config and "pharos" not in config:
            config = {**config, "pharos": node.config["pharos"]}
        return node.model_copy(update={"config": config})


def _mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise PharosError(f"Pharos response field {path} must be an object", code="invalid_response")
    return value


def _string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value:
        raise PharosError(f"Pharos response field {path} must be a string", code="invalid_response")
    return value


def _evidence(submitted: Mapping[str, Any]) -> dict[str, Any]:
    record = _mapping(submitted.get("record"), "record")
    content = _mapping(record.get("content"), "record.content")
    seal = _mapping(record.get("seal"), "record.seal")
    return {
        "record_id": _string(content.get("id"), "record.content.id"),
        "record_sequence": content.get("sequence"),
        "content_hash": _string(seal.get("contentHash"), "record.seal.contentHash"),
        "key_id": _string(seal.get("keyId"), "record.seal.keyId"),
        "replayed": submitted.get("replayed", False),
    }


def _blocked_message(verdict: Mapping[str, Any]) -> str:
    citations = verdict.get("ruleCitations")
    if isinstance(citations, list) and citations and isinstance(citations[0], dict):
        rule = citations[0].get("ruleId", "policy")
        return f"Pharos blocked this step ({rule})"
    return "Pharos blocked this step"


def _stable_id(kind: str, tenant_id: str, run_id: str, node_id: str) -> str:
    digest = hashlib.sha256(f"{tenant_id}\0{run_id}\0{node_id}".encode()).hexdigest()
    return f"keel:{kind}:v1:{digest}"


def _digest(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def _default_oversight(node_type: NodeType) -> OversightMode:
    return "human_in_loop" if node_type == NodeType.TOOL_STEP else "autonomous"


def _default_reversibility(node_type: NodeType) -> Reversibility:
    return "irreversible" if node_type == NodeType.TOOL_STEP else "reversible"
