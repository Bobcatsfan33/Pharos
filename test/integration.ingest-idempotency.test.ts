import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * Replay/idempotency guard on the ingest surface (threat-model issue #74).
 *
 * The ledger is append-only, so a replayed `POST /v1/actions` previously produced a
 * *new sealed record* on every delivery. Every one of those records is individually
 * valid and correctly signed, which is exactly what makes the duplicate dangerous:
 * nothing downstream can tell "the agent acted twice" from "the network retried the
 * same action once". At-least-once delivery is the normal case for an SDK retry, a
 * proxy retry, or a queue redelivery — so the ingest path has to be able to collapse
 * them.
 *
 * A client that supplies `idempotencyKey` now gets exactly-once ingest semantics:
 * the first delivery seals a record, and every subsequent delivery of the *same*
 * request returns that same record without appending. Re-using a key for a
 * *different* request is refused rather than silently collapsed — a key that could
 * be pointed at a different action would let a caller mask an action behind an
 * earlier approval.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-idem-keystore-"));
process.env.PHAROS_ENV = "local";
process.env.PHAROS_PG_URL ??= "postgres://pharos:pharos_local_dev@localhost:5433/pharos";
process.env.PHAROS_REDIS_URL ??= "redis://localhost:6380";
process.env.PHAROS_S3_ENDPOINT ??= "http://localhost:9010";
process.env.PHAROS_S3_REGION ??= "us-east-1";
process.env.PHAROS_S3_BUCKET ??= "pharos-evidence";
process.env.PHAROS_S3_ACCESS_KEY ??= "pharos";
process.env.PHAROS_S3_SECRET_KEY ??= "pharos_local_dev";
process.env.PHAROS_S3_FORCE_PATH_STYLE ??= "true";
process.env.PHAROS_KMS_PROVIDER = "local-kms";
process.env.PHAROS_KMS_KEYSTORE_DIR = keystoreDir;
process.env.PHAROS_ADMIN_TOKEN = "idem-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `idem-${randomUUID().slice(0, 8)}`;
const OTHER_TENANT = `idem-b-${randomUUID().slice(0, 8)}`;
let available = true;
let platform: Platform | null = null;
let app: FastifyInstance | null = null;
const auth = { "x-api-key": "" };
const otherAuth = { "x-api-key": "" };

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    app = await buildApp(platform);
    for (const [tenant, holder] of [
      [TENANT, auth],
      [OTHER_TENANT, otherAuth],
    ] as const) {
      await platform.tenants.createTenant({ tenantId: tenant, displayName: "Idempotency" });
      holder["x-api-key"] = (
        await platform.apiKeys.create(tenant, "idem", [
          "actions:write",
          "liability:assert",
          "records:read",
        ])
      ).plaintext;
    }
  } catch (err) {
    console.warn("[idempotency] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

/** A low-risk action that the cascade allows, so the test exercises ingest, not review. */
function submitBody(tenantId: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    action: {
      type: "email.send",
      agentId: "agent-1",
      payload: { to: "customer@example.com", body: "your order shipped" },
      ...((overrides.action as Record<string, unknown>) ?? {}),
    },
    liability: {
      mandate: null,
      oversightMode: "autonomous" as const,
      blastRadius: {
        financialAmount: 0,
        currency: "USD",
        reversibility: "reversible" as const,
      },
      modelMetadata: null,
      ...((overrides.liability as Record<string, unknown>) ?? {}),
    },
  };
}

async function submit(body: unknown, headers: Record<string, string>) {
  return app!.inject({ method: "POST", url: "/v1/actions", headers, payload: body as object });
}

async function chainCount(tenantId: string, headers: Record<string, string>): Promise<number> {
  const res = await app!.inject({ method: "GET", url: `/v1/chain/${tenantId}`, headers });
  return res.json().data.count as number;
}

describe("ingest replay/idempotency guard", () => {
  it("seals exactly one record for a request delivered twice", async (ctx) => {
    if (!available) return ctx.skip();
    const key = `k-${randomUUID()}`;
    const body = { ...submitBody(TENANT), idempotencyKey: key };

    const before = await chainCount(TENANT, auth);
    const first = await submit(body, auth);
    expect(first.statusCode).toBe(201);
    const firstRecord = first.json().data.record;
    expect(first.json().data.replayed).toBe(false);

    // Byte-identical redelivery — the SDK retry / proxy retry / queue redelivery case.
    const second = await submit(body, auth);

    // 200, not 201: nothing was created by this request.
    expect(second.statusCode).toBe(200);
    expect(second.json().data.replayed).toBe(true);

    const secondRecord = second.json().data.record;
    // The SAME sealed record, not a new one that merely looks alike.
    expect(secondRecord.content.id).toBe(firstRecord.content.id);
    expect(secondRecord.content.sequence).toBe(firstRecord.content.sequence);
    expect(secondRecord.seal.contentHash).toBe(firstRecord.seal.contentHash);
    expect(secondRecord.seal.signature).toBe(firstRecord.seal.signature);

    // The ledger grew by exactly one. This is the assertion that #74 is actually fixed.
    expect(await chainCount(TENANT, auth)).toBe(before + 1);
  });

  it("collapses a burst of concurrent identical deliveries to one record", async (ctx) => {
    if (!available) return ctx.skip();
    const key = `k-${randomUUID()}`;
    const body = { ...submitBody(TENANT), idempotencyKey: key };

    const before = await chainCount(TENANT, auth);
    // Racing deliveries: the guard must hold under concurrency, not just sequentially.
    const responses = await Promise.all(Array.from({ length: 5 }, () => submit(body, auth)));

    const created = responses.filter((r) => r.statusCode === 201);
    const replayed = responses.filter((r) => r.statusCode === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(4);

    const sequences = new Set(responses.map((r) => r.json().data.record.content.sequence));
    expect(sequences.size).toBe(1);
    expect(await chainCount(TENANT, auth)).toBe(before + 1);
  });

  it("refuses a key re-used for a different request instead of collapsing it", async (ctx) => {
    if (!available) return ctx.skip();
    const key = `k-${randomUUID()}`;
    const first = await submit({ ...submitBody(TENANT), idempotencyKey: key }, auth);
    expect(first.statusCode).toBe(201);

    const before = await chainCount(TENANT, auth);
    // Same key, different action. Collapsing this would let a caller hide an action
    // behind a previously-approved one; returning the old record would be a lie.
    const conflicting = await submit(
      {
        ...submitBody(TENANT, {
          action: { type: "payment.transfer", payload: { to: "new-payee", amount: 250_000 } },
        }),
        idempotencyKey: key,
      },
      auth,
    );

    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().error.code).toBe("idempotency_key_reuse");
    // Refused means refused: no record for the second action either.
    expect(await chainCount(TENANT, auth)).toBe(before);
  });

  it("scopes keys per tenant so one tenant cannot collide with another", async (ctx) => {
    if (!available) return ctx.skip();
    const key = `shared-${randomUUID()}`;

    const a = await submit({ ...submitBody(TENANT), idempotencyKey: key }, auth);
    const b = await submit({ ...submitBody(OTHER_TENANT), idempotencyKey: key }, otherAuth);

    // Same key string, different tenants -> two independent records, no cross-tenant leak.
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().data.record.content.id).not.toBe(a.json().data.record.content.id);
    expect(b.json().data.record.content.tenantId).toBe(OTHER_TENANT);
  });

  it("still appends per delivery when the client supplies no key (documented residual)", async (ctx) => {
    if (!available) return ctx.skip();
    // The guard is opt-in, so absent a key the pre-existing at-least-once behavior
    // stands. Pinned deliberately: this is the residual #74 leaves open, and a silent
    // change here would be a breaking change to every existing client.
    const body = submitBody(TENANT);
    const before = await chainCount(TENANT, auth);

    const first = await submit(body, auth);
    const second = await submit(body, auth);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().data.record.content.sequence).not.toBe(
      first.json().data.record.content.sequence,
    );
    expect(await chainCount(TENANT, auth)).toBe(before + 2);
  });

  it("returns the original escalation on replay rather than parking a second one", async (ctx) => {
    if (!available) return ctx.skip();
    const key = `k-${randomUUID()}`;
    // A consequential, irreversible, unmandated action -> the cascade escalates.
    const body = {
      ...submitBody(TENANT, {
        action: {
          type: "payment.transfer",
          payload: { to: "external-payee", amount: 250_000 },
        },
        liability: {
          mandate: null,
          oversightMode: "autonomous" as const,
          blastRadius: {
            financialAmount: 250_000,
            currency: "USD",
            reversibility: "irreversible" as const,
          },
          modelMetadata: null,
        },
      }),
      idempotencyKey: key,
    };

    const first = await submit(body, auth);
    expect(first.statusCode).toBe(201);
    const firstEscalation = first.json().data.escalation;
    // Asserted, not assumed: if the cascade stopped escalating this action the rest of
    // the test would silently prove nothing.
    expect(firstEscalation).not.toBeNull();

    const second = await submit(body, auth);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.replayed).toBe(true);

    // The replay reports the SAME parked escalation — a second review item for one
    // action would double-count a human's workload and could be approved twice.
    expect(second.json().data.escalation?.id).toBe(firstEscalation.id);
    const pending = await platform!.escalations.listPending(TENANT);
    expect(pending.filter((e) => e.id === firstEscalation.id)).toHaveLength(1);
  });
});
