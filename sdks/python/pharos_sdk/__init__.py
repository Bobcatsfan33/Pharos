from .client import PharosClient, PharosError, PharosBlockedError
from .govern import govern_tool, Governor
from .adapters import crewai_tool, ms_agent_tool
# Exported so callers can validate a submission ahead of time (e.g. when building one
# incrementally) using exactly the check submit() applies.
from .validation import validate_submit_input
# MandateToken (Workstream A): offline verification with only the tenant's published key.
from .mandate_token import (
    VerifyResult as MandateTokenVerifyResult,
    canonical_json,
    effective_authority,
    scope_allows_action_type,
    token_block_hashes,
    token_head_hash,
    verify_mandate_token,
)

__all__ = [
    "PharosClient",
    "PharosError",
    "PharosBlockedError",
    "validate_submit_input",
    "verify_mandate_token",
    "effective_authority",
    "scope_allows_action_type",
    "token_block_hashes",
    "token_head_hash",
    "canonical_json",
    "MandateTokenVerifyResult",
    "govern_tool",
    "Governor",
    "crewai_tool",
    "ms_agent_tool",
]
