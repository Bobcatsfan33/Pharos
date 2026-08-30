# Pharos capability platform

Pharos now governs the full path from policy source to external effect. These capabilities
share the existing `ActionRecord`, liability context, signer, and tenant boundary; they are
not separate products or alternate execution paths.

## Capability map

| Capability | Package | What is enforced |
|---|---|---|
| Policy interoperability | `@pharos/policy` | OPA evaluated-JSON and Cedar JSON profiles compile to canonical Pharos rules; source and artifact digests are signed and tamper-checked. Arbitrary Rego text is deliberately not parsed. |
| MCP governance | `@pharos/connectors` | Tool schemas are registered and versioned, drift is detected, tool calls become liability-bound verdict requests, and credentials are newly minted with audience, scope, expiry, and authorization-record bindings. Caller tokens are never forwarded. |
| Governed effects | `@pharos/connectors` | Connectors implement plan, dry-run, execute, verify, and optional compensate. Execution refuses block/escalate verdicts and emits idempotent, digest-bound receipts. |
| Developer workbench | `@pharos/devkit` | Policy simulation, baseline/candidate impact diffs, secret-safe fixture sanitation, and environment diagnostics. |
| Causal evidence graph | `@pharos/observability` | Typed, tenant-isolated, acyclic causal graphs connect runs, tools, verdicts, reviews, credentials, effects, and verification. Export uses parent-linked OpenTelemetry/GenAI attributes. |
| Review operations | `@pharos/review` | Declarative policy selects quorum, required roles, separation of duties, expiry, rejection, and controlled break-glass with retrospective deadlines. |
| Assurance lab | `@pharos/judge-eval` | Dataset provenance, sliced statistical gates, drift thresholds, independent approvals, champion/challenger promotion, and automatic rollback decisions. |
| Enterprise operating plane | `@pharos/config`, `@pharos/core` | Multi-region residency/failover validation plus remote BYOK/HYOK signing transports for Vault Transit, Azure Key Vault, and GCP KMS. The production API remains fail-closed unless a configured provider is available. |
| Compliance mappings | `@pharos/assurance` | Versioned technical-control mappings for NIST AI RMF, ISO 42001, EU AI Act, SOC 2, HIPAA, PCI DSS, and FINRA distinguish enforced/evidenced controls from human or external validation. They never claim certification. |
| Open ecosystem | `@getpharos/pdp-spec`, `@pharos/connectors` | A dependency-free governed-action protocol binds delegation, PDP verdict, signed authorization evidence, and execution receipt; connector plugins have permission manifests and a conformance suite. |

## Workbench

```bash
pnpm pharos:workbench doctor
pnpm pharos:workbench simulate policy.json cases.json
pnpm pharos:workbench diff baseline.json candidate.json cases.json
pnpm pharos:workbench sanitize captured-fixture.json
```

Simulation cases use the same `VerdictRequest` and policy evaluator as the runtime. `diff`
reports every decision transition (`allow->block`, `escalate->allow`, and so on) plus bounded
examples. `sanitize` recursively replaces credential-like fields before a production case is
committed as a regression fixture.

## Policy import and signed promotion artifact

```ts
import { LocalKms } from "@pharos/core";
import { importOpaPolicy, signPolicyBundle, verifyPolicyBundle } from "@pharos/policy";

const imported = importOpaPolicy({
  package: "treasury.guardrails",
  revision: "git:abc123",
  rules: [{
    name: "wire-limit",
    effect: "escalate",
    description: "Large wires require review",
    when: { path: "liability.blastRadius.financialAmount", operator: "gte", value: 25_000 },
  }],
});

const bundle = await signPolicyBundle(imported, signer, "policy:acme");
if (!(await verifyPolicyBundle(bundle, signer))) throw new Error("policy bundle failed verification");
```

OPA integration accepts a portable JSON result produced by a control plane; it does not imply
semantic parsing of arbitrary Rego. Cedar `forbid`, `escalate`, and `modify` policies compile to
rules. Cedar `permit` is recorded as a warning because Pharos represents the absence of a
matching restrictive rule as default allow.

## MCP and connector lifecycle

1. Register the server URL, tool name, input schema, required scopes, and risk metadata.
2. Convert the invocation into a `VerdictRequest`; schema digest, delegation, arguments, and
   liability metadata are preserved.
3. If policy requires it, satisfy an `ApprovalRequirement` with distinct reviewers and roles.
4. Mint a short-lived credential for the MCP server audience and exactly the approved scopes.
5. Ask the connector to plan/dry-run, then execute only under allow/modify authorization.
6. Verify the remote result and bind its receipt to the authorization record and evidence graph.

Connector plugins declare permissions and operations in `pharos.connector-plugin.v1`. Run
`runPluginConformance` before registration; it checks identity, declared operation/permission,
digest-bound planning, and a side-effect-free dry run. The built-in generic HTTP connector sends
an `Idempotency-Key`; exactly-once behavior still depends on the destination honoring it, as
documented in [LIMITATIONS.md](LIMITATIONS.md).

## Assurance and compliance posture

`AssuranceLab` does not promote a challenger unless the statistical gate, drift signals, and
approval count all pass. A failing candidate already deployed as champion produces `rollback`,
not merely a warning. Dataset registration requires source, timestamp, license, slices, and a
processing basis when personal data is present.

`evaluateControlPack` reports technical evidence coverage. An external control remains
`external_validation_required` even when every expected fact is present. This prevents a
dashboard from turning implementation evidence into an unsupported certification claim.

## End-to-end proof

`test/capability-breadth.e2e.test.ts` runs the integrated path: OPA import and signature → MCP
normalization → policy simulation → two-person approval → scoped credential → conforming
connector → verified effect → causal graph/OTel spans → model promotion → control mapping →
residency validation → open-protocol conformance.

Run it alone with:

```bash
pnpm vitest run test/capability-breadth.e2e.test.ts
```
