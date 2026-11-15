# ADR 0002 — Policy interoperability: import an interchange profile, do not embed an engine

- **Status:** Accepted. Implements the interop half of roadmap S9-T1 ([#39](https://github.com/Bobcatsfan33/Pharos/issues/39)).
- **Context:** the Pharos policy compiler is a constrained-grammar compiler over a handful of
  plain-English patterns ([LIMITATIONS §5](../LIMITATIONS.md)). Organisations that already run a
  policy engine — OPA/Rego or Cedar — will not rewrite their rules in it, and should not have to.

## The question

Three ways to meet a team that already has policy-as-code:

1. **Embed the engine.** Vendor an OPA WASM runtime or the Cedar evaluator and evaluate their
   source language directly inside the cascade.
2. **Translate their source language.** Parse Rego or Cedar text and compile it to the Pharos IR.
3. **Adopt an interchange profile.** Accept a documented JSON document each engine can already
   emit, and lower it into the canonical `PolicyArtifact` the rest of the system evaluates.

## Decision: option 3, both profiles, import-only in v1

`packages/policy/src/interop.ts` accepts an **OPA JSON profile** (a Rego author emits it with
`opa eval --format=json`) and a **Cedar JSON profile**, and lowers either into the same
`PolicyArtifact` the grammar compiler produces. From that point the two are indistinguishable:
dry-run, shadow, divergence, activate and rollback all operate on the artifact, which is what
makes the lifecycle parity in the acceptance criteria true by construction rather than by a
parallel implementation.

### Why not embed an engine

The cascade's central claim is a deterministic, citation-backed verdict under a hard deadline,
replayable from a sealed record. An embedded third-party evaluator breaks three properties of
that at once:

- **Determinism and replay.** A verdict must be reproducible from the record years later. That
  requires pinning the exact evaluator build as part of the verdict's identity — the same
  problem the judge models have, solved there with a content-hashed `judgeVersion` and a
  qualified runtime tuple. Doing it for a WASM policy runtime multiplies the trust surface
  for a tier that is supposed to be the *simple*, auditable one.
- **The handoff's own rule.** "No runtime dependency on an external project's code… adopt
  specifications and constructions." An interchange profile is a specification; a vendored
  evaluator is the thing that rule exists to prevent.
- **Citations.** Pharos cites a rule clause a human can read. A general evaluator returns a
  decision, not a clause, so the citation would have to be reconstructed anyway.

### Why not translate the source languages

Rego is a full logic language with comprehensions, built-in functions and partial evaluation;
Cedar has its own type system and entity hierarchy. A partial parser is worse than no parser:
it accepts a policy, silently drops what it did not understand, and the operator believes a
control is live that is not. If we ever do this, it has to be a complete implementation with a
conformance suite, and that is a project, not a task.

The interchange profile avoids the trap because what it cannot express is **enumerated**:
`PolicyImportResult.warnings` names every construct that did not become a rule (a Cedar
`permit` becomes a warning, because permit is already Pharos's default), and the import is
refused outright if the document is not a recognised profile.

## Consequences

- **Provenance survives.** Rule ids are namespaced by source (`cedar:<id>`, `opa:<id>`) and the
  pack id records the originating namespace, so a verdict citation names which engine authored
  the control. `sourceDigest` is the SHA-256 of the submitted document, so the artifact can be
  tied back to the exact text an operator sent.
- **One lifecycle, one evaluator.** `evaluateArtifact` stays the only decision path. There is no
  second engine to keep in step, and no path where a decision exists that the hash-chained
  record cannot explain.
- **The grammar compiler stays the default.** It is simpler and needs no external tooling.
  Interop is for teams who already have the other thing.
- **Export is not in v1.** Pharos → Rego/Cedar would be a lossy compile of a different shape
  (the IR has judge conditions with no Cedar equivalent), and nothing has asked for it. When it
  is asked for, it needs its own unsupported-list and its own ADR.

## Evidence

- `test/policy.interop.test.ts` — OPA and Cedar import, citation preservation, the default-permit
  warning, and signed-bundle tamper detection.
- `test/integration.policy-interop-lifecycle.test.ts` — a Cedar document imported at
  `POST /v1/tenants/:t/policies/compile`, dry-run against recorded traffic (predicting exactly
  the actions over its threshold), refused activation before shadow, promoted, governing a real
  verdict with its own clause cited, then rolled back with the chain verifying throughout. Also
  that an unrecognised document is refused without creating a draft.
