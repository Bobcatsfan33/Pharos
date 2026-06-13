# Open Policy Decision Point (PDP) specification v1.0

Status: **public**. License: Apache-2.0. Reference implementation + conformance suite:
[`@pharos/pdp-spec`](../../packages/pdp-spec). This is a vendor-neutral contract: an agent
action goes in, a verdict comes out, optionally bound to a signed evidence record. Pharos is
the reference *commercial* implementation; the package also ships an **independent reference
implementation** that conforms, demonstrating the spec is implementable by other parties.

## Request

```jsonc
POST /v1/pdp           // tenant is taken from the credential
{
  "action":   { "type": "payment.transfer", "agentId": "agent-1", "payload": { "amount": 30000 } },
  "liability": {
    "mandate":     { "id": "m-1", "limits": { "maxAmount": 25000 } },   // or null
    "oversightMode": "human_in_loop",                                   // autonomous | human_in_loop | human_on_loop
    "blastRadius":   { "financialAmount": 30000, "currency": "USD", "reversibility": "irreversible" }
  },
  "deadlineMs": 800     // optional; PDP MUST respond within this budget
}
```

## Response

```jsonc
{
  "specVersion": "1.0.0",
  "decision":    "block",                    // allow | block | modify | escalate
  "tierReached": 1,                          // 1 | 2 | 3 | "human"
  "riskScore":   1.0,                        // [0,1]
  "ruleCitations": [ { "ruleId": "mandate-limit-exceeded", "pack": "core", "clause": "...", "description": "..." } ],
  "failMode":    null,                        // null | fail_open | fail_closed
  "judgeVersion": null,                       // model id when Tier 3 ran
  "latency":     { "totalMs": 2.1, "deadlineMs": 800, "deadlineBreached": false },
  "evidenceBinding": {                        // OPTIONAL: binds the verdict to a sealed record
    "algorithm": "ed25519",
    "contentHash": "<64-hex>",
    "keyId": "<kms-key-id>",
    "signature": "<base64>"
  }
}
```

## Timeout semantics (normative)

A PDP MUST respond within `deadlineMs`. If it cannot complete in time, it MUST return a
fail-mode response, not hang:

- **reversible** action → `failMode: "fail_open"`, `decision: "allow"` (proceed; queue async review)
- **irreversible** action → `failMode: "fail_closed"`, `decision: "escalate"` (hold for a human)

`latency.deadlineBreached` MUST be `true` whenever a fail-mode is returned for a deadline reason.

## Evidence-binding format (alignment)

When a PDP seals evidence, the response carries an `evidenceBinding`: an Ed25519 signature
over the sealed record's content hash, with the signing `keyId`. A verifier validates it with
the PDP's published public key — the recording-format alignment proposed to the IETF agent
audit-trail work.

## Conformance

```ts
import { runConformance, createReferencePdp } from "@pharos/pdp-spec";
const result = await runConformance(myPdp);   // your implementation under the contract
// result.passed === true  => conforming
```

The suite checks schema validity, the decision/risk ranges, deadline echoing, the fail-mode
semantics above, and citation shape. It tests the **contract**, not any specific policy — so a
PDP with any rule set can conform. The Pharos cascade and the independent reference
implementation both pass (`test/pdp.conformance.test.ts`).
