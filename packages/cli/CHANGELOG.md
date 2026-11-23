# @getpharos/cli

## 0.1.0

### Minor Changes

- 87840b9: `pharos run -- <command>` governs a shell command (verdict, record sealed before anything
  executes, then run / block with exit 2 / hold with exit 3) and `pharos serve` starts the Pharos
  API over embedded storage with an API key for the project tenant. Projects select their policy
  packs in `pharos.yaml`; `init` defaults to the new `coding-agent-safety` pack.
- 1a804ca: Introduce `@getpharos/cli` (bin `pharos`): `init`, `demo`, `log`, `verify`, `export` over the
  embedded backend — a sealed, verified chain with nothing installed but Node ≥ 22.13. The CLI is
  a single esbuild bundle of the workspace packages; the Postgres, Redis, S3 and KMS SDKs are
  now imported lazily by their own modules so the embedded path never loads them (behaviour on
  the Postgres path is unchanged; `createPool` is now async).
- 5d47b64: `pharos hook claude-code` — a Claude Code PreToolUse hook that governs every Bash, Write/Edit,
  Read and MCP tool call (block → deny, escalate → ask, allow → Claude Code's own rules), sealing
  each decision to the project's embedded chain before answering. `pharos init --claude-code`
  installs it into `.claude/settings.json`.

### Patch Changes

- 781eb1e: Qualify `onnxruntime-node@1.31.1` on linux-x64 and darwin-arm64 in the judge model manifest
  the CLI bundles. Measured, not assumed: all 28 records of the committed parity corpus return
  bit-identical probabilities to 1.30.0, with zero decision flips at the frozen 0.5 threshold
  (`docs/benchmarks/ort-1.31-requalification.md`). Without this the pinned runtime is one a
  production API refuses to start on.
