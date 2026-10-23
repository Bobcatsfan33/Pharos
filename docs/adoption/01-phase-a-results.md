# Phase A results — sixty seconds to a sealed verdict

**Measured 2026-10-23** on the Phase A branches (merge order #287 → #284 → #288 → #289 → #290 →
#291 → this). The baseline it beats is `docs/adoption/00-diagnosis.md` (#283); the running
metrics table is `docs/adoption/metrics.md` — both are folded together in a follow-up once
the stack lands, so that no two branches edit the same file.

## Time to first sealed verdict

| Path | Prerequisites | Measured | Evidence |
|---|---|---|---|
| `npm install <packed @getpharos/cli tarball>` → `pharos init` → `pharos demo`, empty project | Node ≥ 22.13 | **1.13 s · 1.16 s · 1.13 s** (three runs: `npm install` ≤ 1 s, 43 packages; `init`+`demo` 0.37 s; the demo's own clock 104 ms) | `scripts/cli-smoke.sh`, CI job `cli-smoke`; transcript `transcripts/cli-init-demo.txt` |
| `npx @getpharos/cli demo` from the registry | Node | **not yet measured — not yet published** (maintainer action). `install-surfaces.yml` measures it daily once the `PHAROS_CLI_PUBLISHED` repository variable is set and fails above 60 s | #292 (A4) |
| `PHAROS_STORAGE_BACKEND=embedded` + `scripts/demo-durability.ts` from a clone | Node, pnpm, git | 0.85 s to first verdict; 0.73 s cold verify | `transcripts/embedded-demo-durability.txt` |
| `pharos run -- git push --force origin main` → BLOCK, cited rule, exit 2 | Node | sub-second; sealed before refusing | `transcripts/cli-run-serve.txt` |
| `pharos serve` → `POST /v1/actions` over HTTP, no Docker | Node | boots in ~1 s | same transcript; CI smoke posts an action and asserts `cas-secret-read` |
| `pnpm test:embedded` (no Docker) | Node, pnpm | 72 tests, 0 skipped | CI job `test-embedded` |
| README's Docker quickstart | + Docker | unchanged (~12 s of commands once images are cached); `pnpm test` is green after following it now that the KMS emulator is in compose | #285 |

**Before → after.** Prerequisites for the quickstart: 4 → **1**. Time to a sealed verdict on a
clean project: unbounded on the measuring host (Docker pull never finished) → **~1.2 s**. The
production path is untouched and is now the README's second section rather than its first.

## What shipped (PRs)

| PR | Task | What |
|---|---|---|
| #283 | A0 | diagnosis + metrics baseline |
| #285 | A0 | KMS emulator in `docker compose` so `pnpm test` is green after the README |
| #286 | A0 | truth pass: runnable Python example, v2 signing bytes, test counts |
| #287 | A0 | main green again: audit-gate bumps + certifi in the training lock (blocks everything else) |
| #284 | A1a | storage ports + Postgres backend factory (behaviour-preserving) |
| #288 | A1b | embedded backend: SQLite + content-addressed record files, one-transaction seal-and-append, conformance suite against both backends, `pnpm test:embedded` + CI job |
| #289 | A1c | `PHAROS_STORAGE_BACKEND`, zero-config embedded, honest posture on `/healthz` and in LIMITATIONS §8 |
| #290 | A2a | `@getpharos/cli`: init / demo / log / verify / export; single bundle; lazy cloud SDKs; tarball smoke in CI; ADR 0006 |
| #291 | A2b | `pharos run`, `pharos serve`, the `coding-agent-safety` pack (39 cases); projects select packs |
| #292 | A4 | scheduled registry checks, Codespaces dev container, `docker run … demo`, Homebrew formula draft |
| this | A3 | README first screen: one sentence, one recording, one command |

## What was deferred, and why

- **`pipx run getpharos demo` (A2 part 4).** The Python SDK is a stdlib HTTP client; "the same
  demo with only Python installed" would mean re-implementing sealing, canonicalisation, the
  Tier-1 engine and a store in Python — a second copy of the trust core to keep in lockstep,
  which §3 of the mandate forbids changing without an ADR and which the crypto-review package
  would have to cover. Proposed instead (next PR): `getpharos verify <bundle>` in pure Python
  (the hand-verify recipe in `docs/security/crypto-review-package.md` already is one), and
  `getpharos demo` that delegates to `npx @getpharos/cli demo` when Node is present and says
  exactly what it needs when it is not. Flagged for the maintainer as a deviation from the AC
  as written.
- **`pharos policy test`** waits for the YAML pack format and fixture directories (C1); the
  39-case table test is the fixture seed.
- **Publishing `@getpharos/cli`** and flipping `PHAROS_CLI_PUBLISHED` are maintainer actions;
  `release.yml` still publishes only `@getpharos/sdk`.
- **`@getpharos/middleware` and `@getpharos/pdp-spec`** remain unpublished despite being named
  in the docs (diagnosis §4); the README now points at the in-repo adapters rather than a
  registry.

## Cold self-review before Phase B

Reading the new first screen as a developer running a coding agent at 11 pm:

1. The first sentence names my problem (shell, git, MCP access), not FINRA wires.
2. The command works with Node alone and the recording shows what it will print, including
   a tampered bundle failing. The number next to it is measured and linked.
3. The `pharos run -- git push --force origin main` line is the wedge in one line.
4. What still makes me leave: nothing here plugs into the agent I already run. The hook
   (`pharos init --claude-code`) and the MCP proxy are Phase B; the README says "next" rather
   than implying they exist.
5. The honest label (not WORM) is on the first screen and links to the production path, so
   the claim is never larger than the code.
