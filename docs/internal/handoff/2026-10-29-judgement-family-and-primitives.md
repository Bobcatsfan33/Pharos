You are working in Bobcatsfan33/Pharos, a pnpm monorepo (TypeScript control plane, Python runtime under runtime/python). Read CONTRIBUTING.md, docs/decision-cascade.md, docs/model-cards/production-judges.md, docs/LIMITATIONS.md and docs/enterprise-readiness.json before touching code. Everything below is scoped to the existing package layout; do not create new top-level directories.

0. Non-negotiables (from the repo's own house rules)
DCO sign-off on every commit. A changeset for every publishable package you touch.
Integration tests run against real Postgres / Redis / MinIO; a skipped integration test fails CI. Never mock the storage layer to make a test pass.
Render configuration, don't read it: new knobs go through packages/config.
Verdict and evidence are written in the same transaction. No workstream below may introduce a path where a decision exists without a sealed record or vice versa.
Every new signal that influences a verdict must be sealed with a content-hashed version (judgeVersion pattern: artifact hash + runtime identity + prompt hash where applicable).
No new runtime dependency on an external project's code for Workstreams A–C. Adopt specifications and constructions; hide implementations behind provider interfaces with a log-only / no-op fallback that preserves today's behavior.
Do not promote any judge. Shadow mode only. docs/enterprise-readiness.json stays decision: not-approved until a human updates it.
1. Why this handoff exists

Pharos today is a policy decision point plus a self-attested evidence ledger. Four structural gaps block it from being the leading option:

Gap    Where it shows    Fix in this handoff
Authority is not portable across agent hops; every action calls home    mandates checked only inside /v1/actions; SDK fail-mode when unreachable    A. MandateToken — offline-attenuable mandates
Linear hash chain cannot prove inclusion/consistency or resist split-view    packages/core chain, docs/evidence-seal.md    B. Merkle log + C2SP checkpoints + witness cosigning
Escalation pause is workflow-level only; no process state in evidence, no rollback    runtime/python durable pause    C. SnapshotProvider with CRIU/docker-checkpoint plugins
Tier 3 is three text classifiers, promotion blocked on evidence, ~8 verdicts/s    packages/judge, packages/cascade, model cards    D. Typed judge panel, routing, shadow mode, evidence flywheel, conformal calibration

Build order: D1 → A → D2 → D3 → B → D4 → C. D1 and A attack the throughput gate first.

Workstream A — MandateToken (portable, attenuable authority)

Package: packages/core (new module src/mandate-token/), consumed by packages/sdk-ts, sdks/python, services/gateway, packages/cascade Tier 1.

Construction (adopted from the Biscuit specification, reimplemented, no library):

Authority block = canonical JSON of the mandate (tenant, agent, scope, limits, expiry, rule citations) signed by the tenant's mandate key via the existing SigningProvider.
Each block carries the public key of the next block's ephemeral keypair. The holder appends an attenuation block (only checks that narrow: tighter limit, shorter expiry, subset of resources/operations) signed with that ephemeral private key, then discards it.
Verification: walk blocks genesis → head, verify each signature against the key published in the prior block, verify the root against the tenant mandate public key. Any block that widens scope is rejected structurally, not by policy.
Checks are expressed as Pharos rule citations (JSON), not Datalog. Do not import or reimplement Biscuit's Datalog.
ts
// packages/core/src/mandate-token/types.ts
export interface MandateAuthority {
  tenantId: string; agentId: string; issuedAt: string; expiresAt: string;
  scope: { actionTypes: string[]; resources: string[] };
  limits: { financialAmount?: number; currency?: string; reversibility?: "reversible" | "irreversible" | "any" };
  citations: string[];                 // rule ids this mandate was granted under
  nextKey: string;                     // base64 Ed25519 pubkey for block 1
}
export interface AttenuationBlock {
  checks: Array<{ kind: "limit" | "expiry" | "scope"; value: unknown }>;
  issuedAt: string; nextKey: string;
}
export interface MandateToken {
  v: 1; authority: MandateAuthority; blocks: AttenuationBlock[];
  signatures: string[];                // one per authority/block, base64
}
export interface MandateTokenCodec {
  mint(a: Omit<MandateAuthority, "nextKey">, signer: SigningProvider): Promise<MandateToken>;
  attenuate(t: MandateToken, b: Omit<AttenuationBlock, "nextKey">, ephemeralPriv: Uint8Array): Promise<MandateToken>;
  verify(t: MandateToken, rootPub: Uint8Array, now: Date): VerifyResult; // pure, offline
  effective(t: MandateToken): MandateAuthority;                          // intersection of all blocks
}

Tasks

Implement codec with canonical JSON (RFC 8785 or the repo's existing canonicalizer).
Conformance suite in packages/core/test/mandate-token/: port the structural test vectors from the Biscuit spec (valid chain, truncated chain, widened scope, expired, wrong root, replayed ephemeral key). Add property tests: effective(attenuate(t)) ⊆ effective(t).
Tier 1 integration: VerdictEngine accepts an optional mandateToken; if present and verified, it supersedes the server-side mandate lookup for the check and the token's block hashes are sealed into the ActionRecord (liability.mandateToken.blockHashes).
Gateway + both SDKs: verify tokens locally before calling /v1/actions; a structurally invalid token is a Tier 1 block without a network call. A valid token on a reversible action with no Tier 2/3 concern may short-circuit to allow only if the tenant's policy sets mandateToken.localAllow: true (default false) — and the SDK must still submit the sealed record asynchronously.
Schema bump in docs/schema-v1.md; replay must reproduce verdicts for records that carry tokens.

Acceptance

Offline verification with only the tenant public key, no DB.
Fuzz: no token mutation can widen effective().
Benchmark: Tier-1-only actions with tokens ≥ 1,000/s on the CI runner, recorded in docs/benchmarks/latency.md as a separate row (do not touch the judge headline).
Workstream B — Merkle log, C2SP checkpoints, witness cosigning

Package: packages/evidence (new module src/tlog/), packages/storage (tile writer), services/api (checkpoint endpoint).

Specs to implement (no Tessera/Trillian code): RFC 6962 Merkle tree hashing; tlog-tiles, tlog-checkpoint, tlog-witness from c2sp.org. Leaves are the existing ActionRecord seal.contentHash in sequence order per tenant.

Tasks

MerkleLog: append-only, RFC 6962 leafHash = SHA256(0x00 || leaf), interior SHA256(0x01 || l || r); inclusion and consistency proofs; pure functions with vectors from RFC 6962 §2.1.
Tile writer: 256-leaf tiles in the tlog-tiles path layout, written to the WORM bucket next to the chain. Tiles are immutable; partial tiles are rewritten until full.
Checkpoint: signed note (origin, tree size, root hash) in tlog-checkpoint format, signed via SigningProvider; GET /v1/tlog/:tenant/checkpoint and tile GETs.
Witness client: submit checkpoints to N configured witness endpoints per tlog-witness; store cosignatures in the bundle. Config in packages/config; zero witnesses = feature inert.
verify:bundle extended: verifies inclusion of every record against the checkpoint and consistency between the bundle's checkpoint and a newer one if supplied. The existing linear-chain verification stays and must still pass unchanged.

Acceptance

Split-view test: two divergent checkpoints at the same tree size are detected by the consistency check.
A third-party witness implementation that speaks tlog-witness can cosign a Pharos checkpoint in an integration test (run a minimal in-repo witness stub; do not vendor one).
Bundle format is backward compatible: old bundles verify with the new verifier.
Workstream C — SnapshotProvider in the Python runtime

Package: runtime/python/pharos_runtime/snapshot/.

python
class SnapshotProvider(Protocol):
    def checkpoint(self, run_id: str, step_id: str) -> SnapshotRef: ...   # returns image hash + locator
    def restore(self, ref: SnapshotRef) -> None: ...
    def fork(self, ref: SnapshotRef, label: str) -> SnapshotRef: ...
    def discard(self, ref: SnapshotRef) -> None: ...
    capabilities: frozenset[str]   # {"checkpoint","restore","fork"} or empty

Implementations: LogOnlySnapshotProvider (default; capabilities empty; today's durable pause), CriuSnapshotProvider (shells out to criu dump/restore, Linux only, detected at startup, never imported as a library), DockerCheckpointProvider (docker checkpoint).

Tasks

Interface + log-only provider; runtime wiring so behavior is byte-identical to today when no other provider is configured.
On escalate: if the provider supports checkpoint, snapshot before pausing and write snapshot.imageHash into the execution log entry and into the ActionRecord submitted for that step. On approval: restore then resume; on block: fork to a quarantined label, roll the live run back to the pre-action snapshot.
CRIU provider behind an integration test gated on criu --version succeeding; skipped providers are reported, not silently green.

Acceptance

Runtime test suite passes with all three providers; log-only path unchanged.
Image hash present in evidence for escalated steps when a capable provider is active.
Workstream D — the judgement family

Tier 3 becomes a panel of typed judges under one contract. The deterministic policy layer still selects the decision; the most severe outcome still wins.

ts
// packages/judge/src/contract.ts
export type JudgeKind = "structural" | "content" | "adversarial" | "intent" | "simulation" | "consensus";
export interface JudgeInput { action: ActionRecordInput; liability: Liability; context: TenantContext; priorSignals: JudgeResult[] }
export interface JudgeResult {
  kind: JudgeKind; concern: string; score: number; confidence: number;
  abstain: boolean; citation?: string; rationale?: string;
  judgeVersion: string;      // sha256(artifact) + ":" + runtimeIdentity [+ ":" + sha256(prompt)]
  latencyMs: number; shadow: boolean;
}
export interface Judge { kind: JudgeKind; appliesTo(action: ActionRecordInput): boolean; evaluate(i: JudgeInput, deadline: Deadline): Promise<JudgeResult> }
D1 — Structural judges + routing + parallelism (first; unblocks throughput)
StructuralJudge: action type ∈ mandate scope; payload validates against the action's schema; tool-call sequence conforms to the allowed plan derived from the causal evidence graph; declared blastRadius consistent with payload (amount, currency, reversibility). Deterministic, no model, promotable immediately.
Routing: appliesTo() on every judge; the registry runs only judges whose concern pack matches the action type (never run finra-promissory on crm.update).
Parallel panel: run applicable judges concurrently under the cascade deadline; seal per-judge latency in verdict.latency.perTier["3"].perJudge.
Acceptance: judge-path p99 for a crm.update with no applicable models < 20 ms; 3-model path runs in max(model) not sum(model). Update docs/benchmarks/latency.md.
D2 — Shadow mode + adversarial judge
shadow: true judges are evaluated and sealed but excluded from decision selection. Add GET /v1/judges/:version/shadow-report summarizing agreement with active judges, score bins (bounded bins only, never text), abstain rate, latency.
AdversarialJudge runs first: canonicalization (unicode NFKC, homoglyph fold, base64/ hex/url decode one level), prompt-injection pattern pack, encoded-payload detector. Emits canonicalText consumed by downstream judges and a concern if decoding changed meaning.
Acceptance: shadow results never affect verdict.decision (property test); the encoded- input over-flagging cases in the model cards become a regression suite.
D3 — Intent judge (LLM-as-judge) behind JudgeProvider
JudgeProvider interface with two implementations: LocalLlmProvider (llama.cpp or vLLM, quantized model, pinned runtime; model file hash sealed) and HostedLlmProvider (API; model id + provider version sealed; tenant opt-in only). Temperature 0, fixed seed, constrained JSON output validated against JudgeResult.
Prompt lives in packages/judge/prompts/intent-v1.md; its SHA-256 is part of judgeVersion. Input: canonical action, effective mandate (from token if present), tenant policy summary, Tier 1/2 signals. Output must cite a rule id from the tenant's active policy or abstain.
Replay contract: docs/decision-cascade.md gains a section stating LLM judges are replayed by input-fingerprint + recorded output, not bit-identical regeneration.
Ships shadow-only. Acceptance: ≥ 2,000 shadow evaluations in CI fixtures with agreement/abstain report generated.
D4 — Evidence flywheel, conformal calibration, consensus
Flywheel: every escalation resolved in packages/review produces a labeled example {canonicalText, concern, humanDecision, reviewerRole, redactionApplied} into packages/judge-eval/corpus/ only when the tenant has judgeCorpus.optIn: true; redaction via the existing evidence redaction path; corpus manifest is hash-chained and provenance-stamped so it can itself serve as promotion evidence item 1.
Conformal calibration: in packages/judge-eval, implement split conformal thresholds per concern (target miscoverage α configurable); judges emit abstain when the conformal set is ambiguous; abstain routes to the existing fail-mode table. This replaces fixed 0.5 thresholds for promoted versions and produces the prevalence-adjusted operating point the model cards require.
ConsensusJudge: N-of-M over active non-shadow judges of different kinds; disagreement above a configured margin → escalate with all member results sealed.
Acceptance: calibration report with coverage/CI per concern; consensus property tests; model cards gain "promotion evidence" links for items 1, 3 and 4 auto-generated from these artifacts.
D5 — Simulation judge (last; depends on C)
If SnapshotProvider.fork is available, fork the sandbox, execute the action against mock connectors (packages/connectors already has governed effects), measure actual affected records/amount, compare to declared blastRadius; discrepancy is a concern.
2. Suggested sprint slicing
Sprint    Scope    Exit gate (measured, sealed in docs/benchmarks/)
S1    D1    no-model action p99 < 20 ms; 3-model path parallel; routing tests
S2    A    offline verify; fuzz no-widen; Tier-1 token path ≥ 1,000/s
S3    D2    shadow never affects decision; adversarial regression suite green
S4    D3    intent judge shadow report on fixtures; replay contract documented
S5    B    split-view detected; stub witness cosigns; old bundles verify
S6    D4    conformal report; consensus tests; corpus manifest chained
S7    C, D5    log-only unchanged; CRIU gated test; image hash in evidence

Each sprint: changesets, docs/status.md entry, docs/LIMITATIONS.md updated with what is now proven and what is still open. Never edit docs/enterprise-readiness.json decision field.

3. Out of scope
Any judge promotion to production.
Replacing OPA/Cedar interchange or the existing policy language.
Vendoring biscuit-rust, Tessera, Trillian, go-criu or CRIU sources into the repo.
Changes to the external evidence-bundle format other than additive fields.
Hosted LLM judge enabled by default for any tenant.
4. Kickoff prompt (paste into Claude Code)

Read docs/handoff/2026-10-29-judgement-family-and-primitives.md, CONTRIBUTING.md, docs/decision-cascade.md, docs/model-cards/production-judges.md and packages/judge/src/*.ts. Start Workstream D1. Before writing code, produce a plan listing every file you will create or modify in packages/judge, packages/cascade and packages/config, the tests you will add, and how verdict.latency.perTier will carry per-judge timings without breaking existing fixtures. Then implement, with integration tests that run against the compose stack. Stop and report when the D1 exit gate numbers are in docs/benchmarks/latency.md. Do not touch judge promotion status.