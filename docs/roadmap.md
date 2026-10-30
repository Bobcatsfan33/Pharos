# Roadmap

What is next, in order. Each item becomes a tracking issue when work starts; the long-form plans
behind them live in [`docs/internal/`](internal/README.md). Anything not on this list is not
committed, however good the idea.

## Next

1. **Portable mandates (`MandateToken`).** Authority an agent can carry across hops and
   attenuate offline — tighter limit, shorter expiry, narrower scope — verified with only the
   tenant's public key. A structurally invalid token is a Tier-1 block with no network call.
   Spec: [handoff, Workstream A](internal/handoff/2026-10-29-judgement-family-and-primitives.md).
2. **Shadow mode and the adversarial judge.** Judges that are evaluated and sealed but never
   decide, plus a first-pass canonicaliser (NFKC, homoglyph fold, one level of base64/hex/url
   decode) so the encoded-input cases that defeat the current judges become a regression suite.
   Spec: [Workstream D2](internal/handoff/2026-10-29-judgement-family-and-primitives.md).
3. **Sixty seconds to a sealed verdict.** An embedded storage mode (SQLite + filesystem, no
   Docker) behind the existing storage interfaces, and a `pharos` CLI so
   `npx @getpharos/cli demo` shows a verdict and a verified chain with nothing but Node
   installed. Labelled honestly: tamper-evident and offline-verifiable, not WORM.

## After that

- **Merkle log with C2SP checkpoints and witness cosigning** — inclusion and consistency proofs
  over the existing chain so a split view is detectable by a third party.
- **Claude Code hook and MCP proxy** — govern a coding agent's shell, git and tool calls with
  one config line, sealing every decision locally.
- **Intent judge behind a `JudgeProvider` seam** — LLM-as-judge, shadow only, prompt hash sealed
  into `judgeVersion`.
- **Snapshot provider in the runtime** — checkpoint before an escalation pause, restore on
  approval, fork to quarantine on block.

## Done recently

- Structural judges, action-type routing and a parallel Tier-3 judge panel
  (judge-path p99 for an action with no applicable model: 0.074 ms; three-model tier runs in
  max, not sum). See [benchmarks/latency.md](benchmarks/latency.md#judge-path-d1).
- Judges requalified on ONNX Runtime 1.30.

## Not planned

- Promoting any Tier-3 judge to production before the evidence in the
  [model cards](model-cards/production-judges.md) exists.
- A hosted service. Pharos is customer-hosted; see the
  [open-core boundary](adr/0001-open-core-boundary.md).
