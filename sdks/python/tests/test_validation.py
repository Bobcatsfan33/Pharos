"""SDK runtime input validation at the trust boundary (threat-model issue #80).

The filed rationale was "defense-in-depth is server-side; the SDK is a thin client". That
holds while the platform is reachable — the server validates and returns 400, which the
SDK rethrows without retrying.

It stops holding the moment the platform is unreachable. The SDK then makes a safety
decision *itself*, reading liability.blastRadius.reversibility out of the same unvalidated
dict to choose fail-open or fail-closed. A caller who misspells or mistypes that field
falls through to the configured default, so under local_fail_mode="fail_open" an
IRREVERSIBLE action is locally ALLOWED — and the server never saw it, because the server
is by definition not reachable. Only the client can defend that path.

The TypeScript conformance for the same contract lives in test/sdk.validation.test.ts.
"""
import pytest

from pharos_sdk import PharosClient, PharosError


def _client(local_fail_mode="fail_closed"):
    # An unreachable base URL forces the local fallback path.
    return PharosClient(
        base_url="http://127.0.0.1:1",
        api_key="k",
        max_retries=0,
        local_fail_mode=local_fail_mode,
    )


ACTION = {"type": "email.send", "agentId": "a1", "payload": {}}
GOOD_LIABILITY = {
    "mandate": None,
    "oversightMode": "autonomous",
    "blastRadius": {"financialAmount": 0, "currency": "USD", "reversibility": "irreversible"},
    "modelMetadata": None,
}


@pytest.mark.parametrize(
    "name,kwargs",
    [
        ("missing tenantId", {"action": ACTION, "liability": GOOD_LIABILITY}),
        ("empty tenantId", {"tenantId": "  ", "action": ACTION, "liability": GOOD_LIABILITY}),
        ("missing action", {"tenantId": "t", "liability": GOOD_LIABILITY}),
        ("action without type", {"tenantId": "t", "action": {"agentId": "a"}, "liability": GOOD_LIABILITY}),
        ("action without agentId", {"tenantId": "t", "action": {"type": "e"}, "liability": GOOD_LIABILITY}),
        ("missing liability", {"tenantId": "t", "action": ACTION}),
        (
            "unknown oversightMode",
            {
                "tenantId": "t",
                "action": ACTION,
                "liability": {**GOOD_LIABILITY, "oversightMode": "supervised"},
            },
        ),
        (
            "unknown reversibility",
            {
                "tenantId": "t",
                "action": ACTION,
                "liability": {
                    **GOOD_LIABILITY,
                    "blastRadius": {"reversibility": "Irreversible"},
                },
            },
        ),
        (
            "misspelled blastRadius key",
            {
                "tenantId": "t",
                "action": ACTION,
                "liability": {
                    "mandate": None,
                    "oversightMode": "autonomous",
                    "blastradius": {"reversibility": "irreversible"},
                },
            },
        ),
        (
            "negative financialAmount",
            {
                "tenantId": "t",
                "action": ACTION,
                "liability": {
                    **GOOD_LIABILITY,
                    "blastRadius": {"reversibility": "reversible", "financialAmount": -1},
                },
            },
        ),
        (
            "non-dict payload",
            {"tenantId": "t", "action": {**ACTION, "payload": "nope"}, "liability": GOOD_LIABILITY},
        ),
        # No coercion: a non-string tenantId is an error, not something to str().
        ("numeric tenantId", {"tenantId": 42, "action": ACTION, "liability": GOOD_LIABILITY}),
    ],
)
def test_rejects_invalid_input_with_named_error(name, kwargs):
    with pytest.raises(PharosError) as excinfo:
        _client().submit(**kwargs)
    assert excinfo.value.code == "invalid_input", name


def test_names_the_offending_field():
    with pytest.raises(PharosError) as excinfo:
        _client().submit(
            tenantId="t",
            action=ACTION,
            liability={**GOOD_LIABILITY, "blastRadius": {"reversibility": "Irreversible"}},
        )
    assert "liability.blastRadius.reversibility" in str(excinfo.value)


def test_rejects_before_transmit():
    """Nothing may reach the wire when the input is invalid."""
    sent = []

    client = _client()
    original = client._request

    def _spy(method, path, body=None):
        sent.append(body)
        return original(method, path, body)

    client._request = _spy
    with pytest.raises(PharosError):
        client.submit(tenantId="", action=ACTION, liability=GOOD_LIABILITY)
    assert sent == []


def test_typo_must_not_let_irreversible_action_fail_open():
    """The concrete hazard #80 creates.

    The operator has deliberately chosen fail_open for reversible low-stakes work. The
    caller sends an IRREVERSIBLE action but misspells the blast-radius key. Before
    validation, reversibility read as absent, fell through to fail_open, and the action
    was locally ALLOWED.
    """
    malformed = {
        "tenantId": "t",
        "action": ACTION,
        "liability": {
            "mandate": None,
            "oversightMode": "autonomous",
            "blastradius": {"reversibility": "irreversible"},
        },
    }
    with pytest.raises(PharosError) as excinfo:
        _client("fail_open").submit(**malformed)
    assert excinfo.value.code == "invalid_input"


def test_valid_irreversible_action_still_fails_closed_when_unreachable():
    """The existing fail-mode contract is untouched for valid input."""
    result = _client("fail_open").submit(
        tenantId="t", action=ACTION, liability=GOOD_LIABILITY
    )
    assert result["localFallback"] is True
    assert result["verdict"]["failMode"] == "fail_closed"
    assert result["verdict"]["decision"] == "escalate"
