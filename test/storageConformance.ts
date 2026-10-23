import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { verifyChain, type SigningProvider, type VerdictContext } from "@pharos/core";
import type { AppendInput } from "@pharos/storage";
import type { StorageBackend } from "@pharos/storage";

/**
 * Storage conformance suite.
 *
 * Every storage backend (Postgres + S3 WORM + Redis, embedded SQLite + files, and any future
 * one) must satisfy exactly these behaviours, so a backend swap is transparent to the API,
 * the verifiers, and the invariants the README states. Mirrors `test/signingConformance.ts`
 * for signing providers.
 *
 * The suite is backend-blind: it only talks to the ports. Backend-specific guarantees (Object
 * Lock, RLS) are asserted in the backend's own tests, never here.
 */
export interface StorageConformanceOptions {
  name: string;
  /** Build a fresh backend plus the signer it was built with. */
  makeBackend: () => Promise<{ backend: StorageBackend; signer: SigningProvider }>;
  /** Backends that must never skip (embedded) set this; Postgres suites skip when infra is down. */
  requireAvailable?: boolean;
}

function verdict(decision: VerdictContext["decision"] = "allow"): VerdictContext {
  return {
    decision,
    tierReached: 1,
    ruleCitations: [],
    riskScore: 0.1,
    failMode: null,
    judgeVersion: null,
    latency: { totalMs: 1, perTier: { "1": 1 }, deadlineMs: 800, deadlineBreached: false },
  };
}

function appendInput(tenantId: string, n: number, extra: Partial<AppendInput> = {}): AppendInput {
  return {
    tenantId,
    action: {
      type: "email.send",
      agentId: "conformance-agent",
      payload: { n, memo: `message ${n}`, amount: 100 * n },
      emittedAt: new Date().toISOString(),
    },
    verdict: verdict(n % 2 === 0 ? "allow" : "block"),
    liability: {
      mandate: null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: 100 * n, currency: "USD", reversibility: "reversible" },
      modelMetadata: null,
    },
    ...extra,
  };
}

export function runStorageConformance(opts: StorageConformanceOptions): void {
  describe(`storage conformance — ${opts.name}`, () => {
    let backend: StorageBackend | null = null;
    let signer: SigningProvider | null = null;
    let available = false;
    const tenantId = `conf-${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      try {
        ({ backend, signer } = await opts.makeBackend());
        available = true;
      } catch (err) {
        if (opts.requireAvailable) throw err;
        console.warn(
          `[storage-conformance:${opts.name}] unavailable, skipping:`,
          (err as Error).message,
        );
      }
    });
    afterAll(async () => {
      await backend?.close();
    });

    const ready = (ctx: { skip: () => void }): boolean => {
      if (!available || !backend || !signer) {
        ctx.skip();
        return false;
      }
      return true;
    };

    it("states an honest evidence posture", (ctx) => {
      if (!ready(ctx)) return;
      const p = backend!.posture;
      expect(["postgres", "embedded"]).toContain(p.backend);
      expect(p.description.length).toBeGreaterThan(20);
      // A backend may not claim WORM unless its immutability tier is object lock.
      if (p.worm) expect(p.immutability).toBe("s3-object-lock-compliance");
    });

    it("append seals records that chain genesis→head and verify against the published keyset", async (ctx) => {
      if (!ready(ctx)) return;
      const records = [];
      for (let n = 0; n < 3; n++)
        records.push(await backend!.store.append(appendInput(tenantId, n)));
      expect(records.map((r) => r.content.sequence)).toEqual([0, 1, 2]);
      expect(records[0]!.seal.prevHash).toBe("0".repeat(64));
      expect(records[1]!.seal.prevHash).toBe(records[0]!.seal.contentHash);
      expect(records[2]!.seal.prevHash).toBe(records[1]!.seal.contentHash);
      expect(records[1]!.content.verdict.decision).toBe("block");

      const chain = await backend!.store.getChain(tenantId);
      expect(chain.map((r) => r.seal.contentHash)).toEqual(records.map((r) => r.seal.contentHash));
      const keyset = await signer!.publishKeyset();
      const report = verifyChain(chain, keyset);
      expect(report.ok, report.errors.join("; ")).toBe(true);
      expect(report.recordsChecked).toBe(3);

      const head = await backend!.store.getHead(tenantId);
      expect(head).toEqual({ sequence: 2, hash: records[2]!.seal.contentHash });
      expect(await backend!.store.count(tenantId)).toBe(3);
      expect(await backend!.store.listTenants()).toContain(tenantId);
      expect(await backend!.store.getRecord(tenantId, 1)).toEqual(records[1]);
      expect(await backend!.store.getRecordById(tenantId, records[2]!.content.id)).toEqual(
        records[2],
      );
      expect(await backend!.store.getRecord(tenantId, 99)).toBeNull();
    });

    it("getRange returns selective-disclosure material bound to each record", async (ctx) => {
      if (!ready(ctx)) return;
      const range = await backend!.store.getRange(tenantId, 0, 1);
      expect(range).toHaveLength(2);
      for (const r of range) {
        expect(r.disclosureRoot).toMatch(/^[0-9a-f]{64}$/);
        expect(r.disclosureSignature.length).toBeGreaterThan(0);
        expect(Object.keys(r.commitments)).toEqual(expect.arrayContaining(["n", "memo", "amount"]));
        expect(r.keyId).toBe(r.record.seal.keyId);
      }
    });

    it("idempotency keys are claimed in the append transaction: replay returns the same record, reuse conflicts", async (ctx) => {
      if (!ready(ctx)) return;
      const key = `k-${randomUUID()}`;
      const fp = "a".repeat(64);
      const first = await backend!.store.append(
        appendInput(tenantId, 10, { idempotency: { key, requestFingerprint: fp } }),
      );
      const replay = await backend!.store.findByIdempotencyKey(tenantId, key, fp);
      expect(replay?.seal.contentHash).toBe(first.seal.contentHash);
      await expect(
        backend!.store.findByIdempotencyKey(tenantId, key, "b".repeat(64)),
      ).rejects.toThrow(/already used/);
      expect(await backend!.store.findByIdempotencyKey(tenantId, `other-${key}`, fp)).toBeNull();
      // A second append under the same key must not seal a second record.
      const before = await backend!.store.count(tenantId);
      await expect(
        backend!.store.append(
          appendInput(tenantId, 11, { idempotency: { key, requestFingerprint: fp } }),
        ),
      ).rejects.toThrow(/claimed concurrently/);
      expect(await backend!.store.count(tenantId)).toBe(before);
      // And the chain is still intact after the rolled-back append.
      const report = verifyChain(
        await backend!.store.getChain(tenantId),
        await signer!.publishKeyset(),
      );
      expect(report.ok, report.errors.join("; ")).toBe(true);
    });

    it("concurrent appends serialize: sequences are gap-free and the chain verifies", async (ctx) => {
      if (!ready(ctx)) return;
      const t = `${tenantId}-par`;
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((n) => backend!.store.append(appendInput(t, n))),
      );
      expect(results.map((r) => r.content.sequence).sort()).toEqual([0, 1, 2, 3, 4]);
      const report = verifyChain(await backend!.store.getChain(t), await signer!.publishKeyset());
      expect(report.ok, report.errors.join("; ")).toBe(true);
      expect(await backend!.store.countInPeriod(t)).toBe(5);
      expect(await backend!.store.countInPeriod(t, undefined, "2000-01-01T00:00:00.000Z")).toBe(0);
    });

    it("reconcileEvidence finds every committed record's evidence copy", async (ctx) => {
      if (!ready(ctx)) return;
      const r = await backend!.store.reconcileEvidence(tenantId);
      expect(r.ok).toBe(true);
      expect(r.missing).toEqual([]);
      expect(r.checked).toBe(await backend!.store.count(tenantId));
    });

    it("tenants: create is upsert on display name; delete marks deleted and reports retention", async (ctx) => {
      if (!ready(ctx)) return;
      const t = await backend!.tenants.createTenant({ tenantId, displayName: "Conformance" });
      expect(t).toMatchObject({
        tenantId,
        status: "active",
        kmsKeyName: `tenant:${tenantId}`,
        retainEvidenceOnDelete: true,
      });
      const again = await backend!.tenants.createTenant({ tenantId, displayName: "Conformance 2" });
      expect(again.displayName).toBe("Conformance 2");
      expect((await backend!.tenants.listTenants()).some((x) => x.tenantId === tenantId)).toBe(
        true,
      );
      await backend!.tenants.setStatus(tenantId, "suspended");
      expect((await backend!.tenants.getTenant(tenantId))?.status).toBe("suspended");
      await backend!.tenants.setStatus(tenantId, "active");
      expect(await backend!.tenants.getTenant("nope")).toBeNull();
      expect(await backend!.tenants.deleteTenant("nope")).toEqual({ evidenceRetained: false });
    });

    it("api keys: only hashes persist; verify/rotate/revoke/list behave identically", async (ctx) => {
      if (!ready(ctx)) return;
      const { record, plaintext } = await backend!.apiKeys.create(tenantId, "ci", [
        "actions:write",
      ]);
      expect(record.scopes).toEqual(["actions:write"]);
      const v = await backend!.apiKeys.verify(plaintext);
      expect(v).toMatchObject({
        keyId: record.keyId,
        tenantId,
        scopes: ["actions:write"],
        name: "ci",
      });
      expect(await backend!.apiKeys.verify(`${plaintext}x`)).toBeNull();
      expect(await backend!.apiKeys.verify("not-a-key")).toBeNull();
      const rotated = await backend!.apiKeys.rotate(tenantId, record.keyId);
      expect(rotated?.record.name).toBe("ci (rotated)");
      expect(await backend!.apiKeys.rotate(tenantId, "missing")).toBeNull();
      await backend!.apiKeys.revoke(tenantId, record.keyId);
      expect(await backend!.apiKeys.verify(plaintext)).toBeNull();
      const list = await backend!.apiKeys.list(tenantId);
      expect(list.find((k) => k.keyId === record.keyId)?.status).toBe("revoked");
      expect(list.find((k) => k.keyId === rotated!.record.keyId)?.status).toBe("active");
      await backend!.tenants.deleteTenant(tenantId);
      expect(await backend!.apiKeys.list(tenantId)).toEqual([]);
      expect((await backend!.tenants.getTenant(tenantId))?.status).toBe("deleted");
    });

    it("access audit: entries chain per tenant and verify", async (ctx) => {
      if (!ready(ctx)) return;
      for (const action of ["view", "export", "verify"] as const) {
        await backend!.accessAudit.record({
          tenantId,
          actor: "auditor",
          actorKind: "api_key",
          action,
          resource: "chain",
        });
      }
      const entries = await backend!.accessAudit.list(tenantId);
      expect(entries.map((e) => e.sequence)).toEqual([0, 1, 2]);
      expect(entries[0]!.prevHash).toBe("0".repeat(64));
      expect(entries[1]!.prevHash).toBe(entries[0]!.entryHash);
      const v = await backend!.accessAudit.verify(tenantId);
      expect(v).toMatchObject({ ok: true, entriesChecked: 3, firstBrokenSequence: null });
    });

    it("mandates: versions supersede, revoke hides, list returns one binding per mandate", async (ctx) => {
      if (!ready(ctx)) return;
      const v1 = await backend!.mandates.create({
        tenantId,
        mandateId: "m-1",
        scope: "s",
        limits: { maxAmount: 1 },
        grantor: "g",
      });
      const v2 = await backend!.mandates.create({
        tenantId,
        mandateId: "m-1",
        scope: "s",
        limits: { maxAmount: 2 },
        grantor: "g",
        expiresAt: null,
      });
      expect([v1.version, v2.version]).toEqual(["1", "2"]);
      expect((await backend!.mandates.getActive(tenantId, "m-1"))?.limits).toEqual({
        maxAmount: 2,
      });
      await backend!.mandates.create({ tenantId, mandateId: "m-2", scope: "s2", grantor: "g" });
      const list = await backend!.mandates.list(tenantId);
      expect(list.map((m) => m.id).sort()).toEqual(["m-1", "m-2"]);
      expect(list.find((m) => m.id === "m-1")?.version).toBe("2");
      await backend!.mandates.revoke(tenantId, "m-1");
      expect(await backend!.mandates.getActive(tenantId, "m-1")).toBeNull();
      expect(await backend!.mandates.getActive(tenantId, "m-2")).not.toBeNull();
    });

    it("escalations: idempotent create, resolve only pending, claimResume is at-most-once per identity", async (ctx) => {
      if (!ready(ctx)) return;
      const key = `esc-${randomUUID()}`;
      const a = await backend!.escalations.create({
        tenantId,
        recordSequence: 1,
        context: { x: 1 },
        idempotencyKey: key,
        queue: "treasury-control",
        priority: 2,
        slaDueAt: "2000-01-01T00:00:00.000Z",
      });
      const b = await backend!.escalations.create({
        tenantId,
        recordSequence: 1,
        context: { x: 2 },
        idempotencyKey: key,
      });
      expect(b.id).toBe(a.id);
      expect(b.context).toEqual({ x: 1 });
      expect((await backend!.escalations.getByIdempotencyKey(tenantId, key))?.id).toBe(a.id);
      expect((await backend!.escalations.listPending(tenantId)).map((e) => e.id)).toContain(a.id);
      expect(
        (await backend!.escalations.listByQueue(tenantId, "treasury-control")).map((e) => e.id),
      ).toContain(a.id);
      expect(
        (await backend!.escalations.queueDepths(tenantId))["treasury-control"],
      ).toBeGreaterThanOrEqual(1);
      const breaches = await backend!.escalations.findNewBreaches(
        tenantId,
        new Date().toISOString(),
      );
      expect(breaches.map((e) => e.id)).toContain(a.id);
      expect(
        (await backend!.escalations.findNewBreaches(tenantId, new Date().toISOString())).map(
          (e) => e.id,
        ),
      ).not.toContain(a.id);
      expect((await backend!.escalations.assign(tenantId, a.id, "alice"))?.assignedTo).toBe(
        "alice",
      );
      // Not yet resolved: claiming is refused.
      expect(await backend!.escalations.claimResume(tenantId, a.id)).toBeNull();
      const resolved = await backend!.escalations.resolve(tenantId, a.id, {
        decision: "approve",
        rationale: "ok",
        resolvedBy: "alice",
      });
      expect(resolved).toMatchObject({ status: "approved", resolvedBy: "alice" });
      expect(resolved?.resolution).toMatchObject({
        decision: "approve",
        rationale: "ok",
        modifiedAction: null,
      });
      expect(
        await backend!.escalations.resolve(tenantId, a.id, {
          decision: "reject",
          rationale: "x",
          resolvedBy: "bob",
        }),
      ).toBeNull();
      expect((await backend!.escalations.listResolved(tenantId)).map((e) => e.id)).toContain(a.id);
      // Stable-identity claims: same identity recovers, a different one is refused.
      expect((await backend!.escalations.claimResume(tenantId, a.id, "run-1"))?.resumeClaimId).toBe(
        "run-1",
      );
      expect(await backend!.escalations.claimResume(tenantId, a.id, "run-2")).toBeNull();
      expect(await backend!.escalations.claimResume(tenantId, a.id, "run-1")).not.toBeNull();
      expect(await backend!.escalations.claimResume(tenantId, a.id)).toBeNull();
      // First-call-wins without an identity.
      const c = await backend!.escalations.create({
        tenantId,
        recordSequence: 2,
        context: {},
        idempotencyKey: `${key}-2`,
      });
      await backend!.escalations.resolve(tenantId, c.id, {
        decision: "modify",
        rationale: "m",
        resolvedBy: "alice",
        modifiedAction: { amount: 1 },
      });
      const [w1, w2] = await Promise.all([
        backend!.escalations.claimResume(tenantId, c.id),
        backend!.escalations.claimResume(tenantId, c.id),
      ]);
      expect([w1, w2].filter(Boolean)).toHaveLength(1);
      expect(
        await backend!.escalations.get(tenantId, "00000000-0000-0000-0000-000000000000"),
      ).toBeNull();
    });

    it("notifier: deliveries are recorded per channel by queue policy", async (ctx) => {
      if (!ready(ctx)) return;
      const channels = await backend!.notifier.fire({
        tenantId,
        event: "breached",
        queue: "treasury-control",
      });
      expect(channels.length).toBeGreaterThanOrEqual(1);
      expect(await backend!.notifier.count(tenantId, "breached")).toBeGreaterThanOrEqual(
        channels.length,
      );
      const list = await backend!.notifier.list(tenantId);
      expect(list[0]).toMatchObject({ tenantId, event: "breached", queue: "treasury-control" });
    });

    it("evidence ops: holds, anchors, and claims packs", async (ctx) => {
      if (!ready(ctx)) return;
      const hold = await backend!.evidenceOps.createHold({
        tenantId,
        name: "h",
        fromSequence: 1,
        toSequence: 2,
        createdBy: "counsel",
      });
      expect(await backend!.evidenceOps.isUnderHold(tenantId, 1)).toBe(true);
      expect(await backend!.evidenceOps.isUnderHold(tenantId, 0)).toBe(false);
      expect((await backend!.evidenceOps.listHolds(tenantId)).map((h) => h.id)).toContain(hold.id);
      await backend!.evidenceOps.releaseHold(tenantId, hold.id);
      expect(await backend!.evidenceOps.isUnderHold(tenantId, 1)).toBe(false);

      const head = (await backend!.store.getHead(tenantId))!;
      await backend!.evidenceOps.createAnchor({
        id: randomUUID(),
        tenantId,
        sequence: head.sequence,
        headHash: head.hash,
        provider: "local",
        tsaTime: new Date().toISOString(),
        tsaSignature: "sig",
        tsaKeyId: "tsa#v1",
        tsaToken: null,
      });
      const anchors = await backend!.evidenceOps.listAnchors(tenantId);
      expect(anchors[anchors.length - 1]).toMatchObject({
        sequence: head.sequence,
        headHash: head.hash,
        provider: "local",
        tsaKeyId: "tsa#v1",
        tsaToken: null,
      });

      const pack = await backend!.evidenceOps.createPack({
        tenantId,
        audience: "regulator",
        fromSequence: 0,
        toSequence: 1,
        redactFields: ["memo"],
      });
      expect(pack).toMatchObject({ status: "draft", redactFields: ["memo"], bundle: null });
      expect(await backend!.evidenceOps.releasePack(tenantId, pack.id, "x")).toBeNull();
      const sealed = await backend!.evidenceOps.sealPack(tenantId, pack.id, { records: 2 });
      expect(sealed).toMatchObject({ status: "sealed", bundle: { records: 2 } });
      expect(await backend!.evidenceOps.sealPack(tenantId, pack.id, {})).toBeNull();
      expect((await backend!.evidenceOps.releasePack(tenantId, pack.id, "counsel"))?.status).toBe(
        "released",
      );
      expect((await backend!.evidenceOps.getPack(tenantId, pack.id))?.releasedTo).toBe("counsel");
      expect((await backend!.evidenceOps.listPacks(tenantId)).map((p) => p.id)).toContain(pack.id);
    });

    it("policies: draft → shadow → active archives the prior version; rollback restores it", async (ctx) => {
      if (!ready(ctx)) return;
      const v1 = await backend!.policyStore.createDraft({
        tenantId,
        name: "p",
        artifact: { v: 1 },
        sourceText: "block x",
      });
      expect(v1).toMatchObject({
        version: 1,
        status: "draft",
        artifact: { v: 1 },
        sourceText: "block x",
      });
      expect((await backend!.policyStore.setStatus(tenantId, v1.id, "shadow"))?.status).toBe(
        "shadow",
      );
      expect(await backend!.policyStore.getShadowArtifacts(tenantId)).toEqual([{ v: 1 }]);
      expect((await backend!.policyStore.activate(tenantId, v1.id))?.status).toBe("active");
      const v2 = await backend!.policyStore.createDraft({
        tenantId,
        name: "p",
        artifact: { v: 2 },
      });
      expect(v2.version).toBe(2);
      await backend!.policyStore.activate(tenantId, v2.id);
      expect((await backend!.policyStore.get(tenantId, v1.id))?.status).toBe("archived");
      expect(await backend!.policyStore.getActiveArtifacts(tenantId)).toEqual([{ v: 2 }]);
      const rb = await backend!.policyStore.rollback(tenantId, "p");
      expect(rb.rolledBack?.id).toBe(v2.id);
      expect(rb.restored?.id).toBe(v1.id);
      expect(await backend!.policyStore.getActiveArtifacts(tenantId)).toEqual([{ v: 1 }]);
      expect((await backend!.policyStore.list(tenantId)).map((p) => p.version)).toEqual([2, 1]);
      expect(await backend!.policyStore.activate(tenantId, randomUUID())).toBeNull();
      expect(await backend!.policyStore.rollback(tenantId, "nothing")).toEqual({
        rolledBack: null,
        restored: null,
      });
    });

    it("assurance: sampling is idempotent per record; stats count upheld audits; exceptions upsert", async (ctx) => {
      if (!ready(ctx)) return;
      const added = await backend!.assurance.sample(tenantId, [
        { recordSequence: 0, pack: "finra", decision: "allow" },
        { recordSequence: 1, pack: null, decision: "block" },
      ]);
      expect(added).toBe(2);
      expect(
        await backend!.assurance.sample(tenantId, [
          { recordSequence: 0, pack: "finra", decision: "allow" },
        ]),
      ).toBe(0);
      const pending = await backend!.assurance.listPending(tenantId);
      expect(pending).toHaveLength(2);
      await backend!.assurance.recordAudit(tenantId, pending[0]!.id, true, "auditor");
      await backend!.assurance.recordAudit(tenantId, pending[1]!.id, false, "auditor");
      expect(await backend!.assurance.stats(tenantId)).toEqual({ total: 2, upheld: 1 });
      expect(await backend!.assurance.stats(tenantId, "finra")).toEqual({ total: 1, upheld: 1 });
      const byPack = await backend!.assurance.statsByPack(tenantId);
      expect(byPack.finra).toEqual({ total: 1, upheld: 1 });
      expect(byPack.core).toEqual({ total: 1, upheld: 0 });
      await backend!.assurance.grantException(tenantId, "mandate-coverage", "cfo", "pilot");
      await backend!.assurance.grantException(tenantId, "mandate-coverage", "ceo");
      expect(await backend!.assurance.exceptions(tenantId)).toEqual({ "mandate-coverage": "ceo" });
      await backend!.assurance.revokeException(tenantId, "mandate-coverage");
      expect(await backend!.assurance.exceptions(tenantId)).toEqual({});
    });

    it("counters: fixed windows count per key and ping reports liveness", async (ctx) => {
      if (!ready(ctx)) return;
      await backend!.counters.connect();
      const key = `rl:conf:${randomUUID()}`;
      expect(await backend!.counters.incr(key, 60)).toBe(1);
      expect(await backend!.counters.incr(key, 60)).toBe(2);
      expect(await backend!.counters.ping()).toBe(true);
    });
  });
}
