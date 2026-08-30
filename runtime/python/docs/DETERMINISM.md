# KEEL determinism contract

> **Status: enforced (M1).** This is the written contract *and* it is enforced in code:
> a CI **nondeterminism lint gate** (`python -m keel._lint.determinism keel`) blocks any
> source that bypasses an L1 port; an **effect ledger** gives side-effect-once across
> crash and resume; a **conformance suite** replays a 50+ run corpus byte-identically;
> and a **chaos** test proves a crashed step's model/tool calls are not re-issued. The
> few items still marked **partial** are called out below.

## What "deterministic replay" means here

A *recorded run* is its append-only event log. **Replay** re-drives the executor while
feeding every nondeterministic value back from the log through L1 *replay ports*, so
the run reproduces. The guarantee is about the **final result and the event sequence**
of an executor-driven run — not wall-clock timing, not live stream pacing.

`keel replay <run_id>` performs a recorded replay and asserts byte-identity; a
divergence is reported, never silently re-executed live.

## Nondeterminism sources and their current guarantee

| Source | L1 port | Live | Replay | Guarantee today |
|--------|---------|------|--------|-----------------|
| Wall-clock time | `Clock.now()` | `SystemClock` | `ReplayClock` (recorded timestamps) | **Guaranteed** — `now()` returns the recorded value in order |
| Monotonic time | `Clock.monotonic()` | `SystemClock` | frozen counter | **By design not persisted** — used only for local scheduling/budget wall-clock, never folded into state |
| Identifiers | `IdGen.new()` | `UlidIdGen` | `ReplayIdGen` (recorded ids) | **Guaranteed** — every event id is replayed in order |
| Randomness | `Rng` | `SeededRng(seed)` | `SeededRng(0)` | **Partial** — replay uses a fixed seed and core handlers don't draw from `rng`; the seed is not yet recorded. Don't rely on `ctx.rng` for replayable decisions until M1. |
| Model calls | `ModelPort` | provider over httpx | `RecordedModelPort` (recorded responses) | **Guaranteed** — recorded `llm.response` text/tokens fed back in call order; an extra/missing call is a reported divergence. **Side-effect-once:** a call committed before a crash replays from the effect ledger on resume — not re-issued, not re-billed |
| Tool calls | tool gateway | in-proc / sandbox | `RecordedToolGateway` (recorded outputs) | **Guaranteed** — recorded `tool.request`/`tool.response` are replayed verbatim; side-effect-once via an idempotency key (`hash(node, args)`). A non-idempotent tool that *started but never committed* (crash mid-effect) is **detected** and follows the recovery policy (fail; idempotent tools retry) |
| Streaming | `ModelPort.stream()` | provider stream (assembled) | recorded final | **Guaranteed (final result)** — streamed chunks are assembled into the final result and recorded; replay reconstructs the identical final and `llm.response`. Live stream *timing* is not persisted (a UI can re-emit from the final) |
| Environment reads | — | direct `os.environ` | — | **Not ported** — a handler reading env directly is invisible to replay (the M1 lint gate forbids new direct reads) |
| Filesystem | `BlobStore` (payloads) | `FileBlobStore` | content-addressed | Payloads are content-addressed and stable; arbitrary handler filesystem reads are **not ported** |
| Network | `ModelPort` / tool gateway | httpx | — | Model/tool network is mediated; arbitrary handler network is **not ported** (the sandbox blocks undeclared tool network; M1 lint forbids new unwrapped network in handlers) |

## Known limits (today)

- **Externally-appended events.** A human gate's `gate.approved`/`gate.rejected` is
  appended outside the executor. Recorded replay reproduces the executor's events; the
  external decisions are a documented extension and are re-injected, not re-derived.
- **Parallel frontier ordering.** Independent frontier nodes run concurrently via
  `asyncio.gather`; event *interleaving* across independent branches is a function of
  the recorded sequence and is reproduced from it, not re-raced.

## The port discipline (how it's enforced)

Higher layers depend only on the L1 `Protocol`s (`Clock`, `IdGen`, `Rng`, `BlobStore`,
`ModelPort`) — never on a concrete clock, RNG, or network call. The executor injects a
live implementation at run construction and a replay implementation at replay
construction. `import-linter` forbids upward imports; the **nondeterminism lint gate**
(`keel/_lint/determinism.py`, run in CI) is an AST check that fails the build when code
introduces a direct `time.time()`, `datetime.now()`, `uuid4()`, `random.*`, or raw
`socket.socket()` instead of a port. A line may opt out with `# det-ok: <reason>` (and
that waiver is then auditable); a small allowlist covers the ports themselves and the
sandbox fixtures. **Side-effect-once** is the `keel.executor.effects.EffectLedger`: it
folds the prior log into committed/in-flight effects so a resumed step replays its
already-made calls instead of re-issuing them.

## Versioning this contract

When a guarantee changes (e.g. tool replay moves from *partial* to *guaranteed* in
M1), this table is updated in the same PR that lands the enforcing test, and the README
claim is promoted only then. The event envelope and its versioning are documented
separately in [`EVENT-SCHEMA.md`](EVENT-SCHEMA.md) (M2).
