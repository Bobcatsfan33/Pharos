"""Runtime validation at the SDK trust boundary (#80).

The SDK is a thin client and the server does validate, so for a *reachable* platform this
is only faster feedback. It is a safety control rather than a convenience because of the
unreachable case: ``submit()`` then applies a local fail-mode chosen by reading
``liability.blastRadius.reversibility`` out of this same dict. A caller who misspells or
mistypes that field falls through to the configured default, so an irreversible action can
be locally ALLOWED under ``local_fail_mode="fail_open"`` — and the server never sees it,
because the server is by definition not reachable. The server cannot defend that path.

Two deliberate design choices, mirroring the TypeScript validator exactly:

* **Required/typed/enum checks only; unknown keys are permitted.** Rejecting unknown keys
  would break forward compatibility the first time the server grows a field. A misspelled
  key is still caught, because the correctly-spelled required field is then missing.
* **No coercion.** A numeric ``tenantId`` is an error, not something to ``str()``.
  Silently repairing input means the record sealed as evidence is not the thing the caller
  actually asked to govern.

Kept stdlib-only on purpose: ``getpharos`` ships with no dependencies.
"""
from numbers import Real
from typing import Any

OVERSIGHT_MODES = ("autonomous", "human_in_loop", "human_on_loop")
REVERSIBILITY = ("reversible", "irreversible")


def _invalid(path: str, expected: str):
    # Imported lazily to avoid a circular import with client.py.
    from .client import PharosError

    raise PharosError(f"invalid submit input: {path} {expected}", "invalid_input")


def _require_non_empty_string(value: Any, path: str) -> None:
    # bool is a subclass of int, not str, so no special-casing needed here.
    if not isinstance(value, str):
        _invalid(path, "must be a string")
    if value.strip() == "":
        _invalid(path, "must not be empty")


def _optional_string(value: Any, path: str) -> None:
    if value is None:
        return
    _require_non_empty_string(value, path)


def validate_submit_input(payload: dict) -> None:
    """Validate a submission before transmit.

    Raises ``PharosError`` with ``code == "invalid_input"`` naming the offending field.
    """
    if not isinstance(payload, dict):
        _invalid("input", "must be an object")

    _require_non_empty_string(payload.get("tenantId"), "tenantId")
    _optional_string(payload.get("mandateId"), "mandateId")
    _optional_string(payload.get("idempotencyKey"), "idempotencyKey")

    # --- action ---
    action = payload.get("action")
    if not isinstance(action, dict):
        _invalid("action", "must be an object")
    _require_non_empty_string(action.get("type"), "action.type")
    _require_non_empty_string(action.get("agentId"), "action.agentId")
    _optional_string(action.get("sessionId"), "action.sessionId")
    if "payload" in action and action["payload"] is not None:
        if not isinstance(action["payload"], dict):
            _invalid("action.payload", "must be an object when present")

    # --- liability ---
    # This is the sub-object the local fail-mode reads, so it is validated strictly even
    # though the server would also check it.
    liability = payload.get("liability")
    if not isinstance(liability, dict):
        _invalid("liability", "must be an object")

    if liability.get("oversightMode") not in OVERSIGHT_MODES:
        _invalid("liability.oversightMode", "must be one of " + ", ".join(OVERSIGHT_MODES))

    blast_radius = liability.get("blastRadius")
    if not isinstance(blast_radius, dict):
        _invalid("liability.blastRadius", "must be an object")

    if blast_radius.get("reversibility") not in REVERSIBILITY:
        # The field the local fail-mode depends on. Naming it explicitly matters: this is
        # the error that stops an irreversible action being allowed by a typo.
        _invalid(
            "liability.blastRadius.reversibility",
            "must be one of " + ", ".join(REVERSIBILITY),
        )

    amount = blast_radius.get("financialAmount")
    if amount is not None:
        # Reject bool explicitly: True would otherwise pass as a Real worth 1.
        if isinstance(amount, bool) or not isinstance(amount, Real):
            _invalid("liability.blastRadius.financialAmount", "must be a finite number")
        if amount != amount or amount in (float("inf"), float("-inf")):  # NaN / inf
            _invalid("liability.blastRadius.financialAmount", "must be a finite number")
        if amount < 0:
            _invalid("liability.blastRadius.financialAmount", "must not be negative")
    _optional_string(blast_radius.get("currency"), "liability.blastRadius.currency")
    _optional_string(blast_radius.get("notes"), "liability.blastRadius.notes")

    # --- optional nested objects ---
    mandate = liability.get("mandate")
    if mandate is not None:
        if not isinstance(mandate, dict):
            _invalid("liability.mandate", "must be an object or null")
        _require_non_empty_string(mandate.get("id"), "liability.mandate.id")
        _require_non_empty_string(mandate.get("grantor"), "liability.mandate.grantor")
        if not isinstance(mandate.get("scope"), str):
            _invalid("liability.mandate.scope", "must be a string")

    model = liability.get("modelMetadata")
    if model is not None:
        if not isinstance(model, dict):
            _invalid("liability.modelMetadata", "must be an object or null")
        _require_non_empty_string(model.get("provider"), "liability.modelMetadata.provider")
        _require_non_empty_string(model.get("model"), "liability.modelMetadata.model")
