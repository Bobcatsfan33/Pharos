"""Wire types for the Pharos PDP contract.

Generated from packages/pdp-spec/schema/pdp-v1.schema.json by
sdks/python/scripts/gen_types.py. Do not edit; regenerate.
Contract version 1.0.0, schema sha256 17675fa8b0c608af30611c749add9badac881050a1297c33f084ead5a6b604fe.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union

PDP_SPEC_VERSION = '1.0.0'
SCHEMA_SHA256 = '17675fa8b0c608af30611c749add9badac881050a1297c33f084ead5a6b604fe'

Decision = Literal['allow', 'block', 'modify', 'escalate']

Reversibility = Literal['reversible', 'irreversible']

OversightMode = Literal['autonomous', 'human_in_loop', 'human_on_loop']

FailMode = Union[Literal['fail_open', 'fail_closed'], None]

TierReached = Literal[1, 2, 3, 'human']

SignatureAlgorithm = Literal['ed25519', 'ecdsa-p256']

class _RuleCitationOptional(TypedDict, total=False):
    clause: str
    description: str


class RuleCitation(_RuleCitationOptional):
    ruleId: str
    pack: str


class _ModelMetadataOptional(TypedDict, total=False):
    version: str


class ModelMetadata(_ModelMetadataOptional):
    provider: str
    model: str


class _BlastRadiusInputOptional(TypedDict, total=False):
    financialAmount: float
    currency: str
    notes: str


class BlastRadiusInput(_BlastRadiusInputOptional):
    reversibility: Reversibility


class _MandateInputOptional(TypedDict, total=False):
    limits: dict[str, Any]
    expiresAt: Union[str, None]
    version: str


class MandateInput(_MandateInputOptional):
    id: str
    scope: str
    grantor: str


class _ActionInputOptional(TypedDict, total=False):
    sessionId: str
    payload: dict[str, Any]


class ActionInput(_ActionInputOptional):
    type: str
    agentId: str


class _LiabilityInputOptional(TypedDict, total=False):
    mandate: Union[MandateInput, None]
    modelMetadata: Union[ModelMetadata, None]


class LiabilityInput(_LiabilityInputOptional):
    oversightMode: OversightMode
    blastRadius: BlastRadiusInput


class _VerdictLatencyOptional(TypedDict, total=False):
    perTier: dict[str, Any]


class VerdictLatency(_VerdictLatencyOptional):
    totalMs: float
    deadlineMs: float
    deadlineBreached: bool


class Verdict(TypedDict):
    decision: Decision
    tierReached: TierReached
    riskScore: float
    ruleCitations: list[RuleCitation]
    failMode: FailMode
    judgeVersion: Union[str, None]
    latency: VerdictLatency


class _PdpRequestOptional(TypedDict, total=False):
    deadlineMs: float


class PdpRequest(_PdpRequestOptional):
    action: dict[str, Any]
    liability: dict[str, Any]


class PdpEvidenceBinding(TypedDict):
    algorithm: SignatureAlgorithm
    contentHash: str
    keyId: str
    signature: str


class _PdpResponseOptional(TypedDict, total=False):
    evidenceBinding: PdpEvidenceBinding


class PdpResponse(_PdpResponseOptional):
    specVersion: Literal['1.0.0']
    decision: Decision
    tierReached: TierReached
    riskScore: float
    ruleCitations: list[RuleCitation]
    failMode: FailMode
    judgeVersion: Union[str, None]
    latency: dict[str, Any]
